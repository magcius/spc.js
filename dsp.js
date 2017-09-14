window.$moduleDSP = (function(exports) {
    "use strict";

    var GLOBAL_REG_MASTER_VOL_L = 0x0C; // Left-channel master-volume
    var GLOBAL_REG_MASTER_VOL_R = 0x1C; // Right-channel master volume
    var GLOBAL_REG_ECHO_VOL_L   = 0x2C; // Left-channel echo volume
    var GLOBAL_REG_ECHO_VOL_R   = 0x3C; // Right-channel echo volume
    var GLOBAL_REG_KEY_ON       = 0x4C; // Key on, each bit denotes a voice.
    var GLOBAL_REG_KEY_OFF      = 0x5C; // Key off, value same as above
    var GLOBAL_REG_FLAG         = 0x6C; // Controls reset, mute, echo and noise clock
    var GLOBAL_REG_ENDX         = 0x7C; // Denotes end-of-sample. (Not implemented)

    var GLOBAL_REG_PITCH_MOD    = 0x2D; // Pitch modulation
    var GLOBAL_REG_NOISE_ON     = 0x3D; // Noise on/off
    var GLOBAL_REG_DIR          = 0x5D; // Offset of source directory

    var VOICE_REG_VOL_L         = 0x00; // Left-channel voice volume
    var VOICE_REG_VOL_R         = 0x01; // Right-channel voice volume
    var VOICE_REG_PITCH_L       = 0x02; // Low byte of pitch
    var VOICE_REG_PITCH_H       = 0x03; // High byte of pitch
    var VOICE_REG_SOURCE        = 0x04; // Source number, from 0-256
    var VOICE_REG_ADSR0         = 0x05;
    var VOICE_REG_ADSR1         = 0x06;

    var CLOCKS_PER_SAMPLE = 32;

    function clamp16(v) {
        if (v < -32768) v = -32768;
        if (v >  32767) v =  32767;
        return v;
    }

    var EnvelopeState = {
        RELEASE: 0, ATTACK: 1, DECAY: 2, SUSTAIN: 3,
    };

    function newVoice(ctx) {
        var voice = {};

        // The index of the sample to be looked up in the directory.
        voice.sourceIndex = null;

        // The address of the header of the BRR-encoded data we're playing.
        voice.sampleAddr = null;
        voice.sampleOffs = null;

        // The raw samples of each buffer. We also mirror the buffer again
        // to make wraparound handling easier.
        voice.brrBuffer = new Int16Array(12 * 2);
        voice.brrPos = 0;

        voice.volumeL = 1.0;
        voice.volumeR = 1.0;

        voice.envelopeState = EnvelopeState.RELEASE;
        voice.envx = 0;
        voice.newEnvx = 0;
        voice.interpPos = 0;

        return voice;
    }

    function RATE(rate, div) {
        return rate >= div ? (((rate / div) | 0) * 8 - 1) : rate - 1;
    }

    var COUNTER_MASK = [
        RATE(   2,2), RATE(2048,4), RATE(1536,3),
    	RATE(1280,5), RATE(1024,4), RATE( 768,3),
    	RATE( 640,5), RATE( 512,4), RATE( 384,3),
    	RATE( 320,5), RATE( 256,4), RATE( 192,3),
    	RATE( 160,5), RATE( 128,4), RATE(  96,3),
    	RATE(  80,5), RATE(  64,4), RATE(  48,3),
    	RATE(  40,5), RATE(  32,4), RATE(  24,3),
    	RATE(  20,5), RATE(  16,4), RATE(  12,3),
    	RATE(  10,5), RATE(   8,4), RATE(   6,3),
    	RATE(   5,5), RATE(   4,4), RATE(   3,3),
    	              RATE(   2,4),
    	              RATE(   1,4),
    ];
    var COUNTER_SELECT = [0,2,1,3,2,1,3,2,1,3,2,1,3,2,1,3,2,1,3,2,1,3,2,1,3,2,1,3,2,1,2,2];

    function DSP(state) {
        this._time = CLOCKS_PER_SAMPLE + 1;
        this._counters = [1, 0, -0x20, 0x0B];
        this._everyOtherSample = true;

        this._regs = state.regs;
        this._sregs = new Int8Array(this._regs.buffer, this._regs.byteOffset, this._regs.byteLength);

        this._ram = state.ram;
        this._voices = [];
        for (var i = 0; i < 8; i++)
            this._voices.push(newVoice());
    }

    DSP.prototype._runCounter = function(i) {
        var n = this._counters[i];
        if ( !(n-- & 7) )
            n -= 6 - i;
        this._counters[i] = n & 0xFFFF;
    };

    DSP.prototype.getRegister = function(index) {
        // console.log("REG GET", index);
        return this._regs[index];
    };

    DSP.prototype.setRegister = function(index, value) {
        // console.log("REG SET", index.toString(16), value);
        this._regs[index] = value;
    };

    DSP.prototype.runUntil = function(endTime) {
        // The DSP emits a sample every 32 CPU cycles.

        // endTime is *exclusive*. We don't actually run all the way until endTime
        // if it's locked on phase. That will happen in the next period.
        endTime--;

        var oldCycles = Math.floor(this._time / CLOCKS_PER_SAMPLE);
        var newCycles = Math.floor(endTime / CLOCKS_PER_SAMPLE);
        this._time = endTime;

        var nSamples = newCycles - oldCycles;
        if (!nSamples)
            return;

        // Returns the index for a voice register, given
        // the voice number and the register
        function voiceRegAddr(v, reg) {
            return (v * 0x10) | reg;
        }

        var ram = this._ram;

        function getLE16(addr) {
            return ram[addr] | (ram[addr+1] << 8);
        }

        // Returns the directory entry for source number "index".
        //
        // The directory contains two addresses: a "start" address
        // for when sounds are just turned on, and a "loop" address
        // where sounds loop back to on the loop bit.
        var dirAddr = this._regs[GLOBAL_REG_DIR] * 0x100;

        var DirEntry = { START: 0, LOOP: 2 };

        function getDirectoryEntry(index, which) {
            var addr = dirAddr + (index * 4) + which;
            return getLE16(addr);
        }

        function brrDecode(voice) {
            function appendNibble(nb, scale, filter) {
                var signedNb = (nb << 28 >> 28);
                var sample = (signedNb << scale) >> 1;
                var rs = sample;
                if (scale > 12) XXX;

                var buffer = voice.brrBuffer;
                var wp = voice.brrPos;

                /*
                if (filter == 1)
                    buffer[wp] += ((buffer[wp+12-1] * (15/16)));
                else if (filter == 2)
                    buffer[wp] += ((buffer[wp+12-1] * (61/32))  - (buffer[wp+12-2] * 15/16));
                else if (filter == 3)
                    buffer[wp] += ((buffer[wp+12-1] * (115/64)) - (buffer[wp+12-2] * 13/16));
                */

                var p1 = buffer[wp + 12 - 1];
                var p2 = buffer[wp + 12 - 2] >> 1;

                if (filter == 1) {
                    sample += p1 >> 1;
                    sample += (-p1) >> 5;
                } else if (filter == 2) {
                    sample += p1;
                    sample -= p2;
                    sample += p2 >> 4;
                    sample += (p1 * -3) >> 6;
                } else if (filter == 3) {
                    sample += p1;
                    sample -= p2;
                    sample += (p1 * -13) >> 7;
                    sample += (p2 * 3) >> 4;
                }

                sample = clamp16(sample);
                sample = (sample << 1) & 0xFFFF;

                buffer[wp] = sample;
                buffer[wp+12] = buffer[wp];
                wp++;

                if (wp >= 12)
                    wp = 0;

                voice.brrPos = wp;
            }

            // This decodes 4 samples at a time, so we chew up two bytes of
            // BRR data.

            var header = ram[voice.sampleAddr];
            var byte1 = ram[voice.sampleAddr + (++voice.sampleOffs)];
            var byte2 = ram[voice.sampleAddr + (++voice.sampleOffs)];

            var scale = (header >> 4);
            var filter = (header >> 2) & 3;

            appendNibble(byte1 >> 4,   scale, filter);
            appendNibble(byte1 & 0x0F, scale, filter);
            appendNibble(byte2 >> 4,   scale, filter);
            appendNibble(byte2 & 0x0F, scale, filter);

            // We're at the end of the sample.
            if (voice.sampleOffs == 8) {
                if (header & 2) {
                    // Loop bit.
                    voice.sampleAddr = getDirectoryEntry(voice.sourceIndex, DirEntry.LOOP);
                    voice.sampleOffs = 0;
                } else if (header & 1) {
                    // End of the sample.
                    voice.envelopeState = EnvelopeState.RELEASE;
                    voice.newEnvx = voice.envx = 0;
                    voice.sampleAddr = null;
                    voice.sampleOffs = null;
                } else {
                    // Go to the next BRR chunk.
                    voice.sampleAddr += 9;
                    voice.sampleOffs = 0;
                }
            }
        }

        function gaussianInterpolate(voice) {
            var GAUSS_TABLE = [
                     0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,
                     1,    1,    1,    1,    1,    1,    1,    1,    1,    1,    1,    2,    2,    2,    2,    2,
                     2,    2,    3,    3,    3,    3,    3,    4,    4,    4,    4,    4,    5,    5,    5,    5,
                     6,    6,    6,    6,    7,    7,    7,    8,    8,    8,    9,    9,    9,   10,   10,   10,
                    11,   11,   11,   12,   12,   13,   13,   14,   14,   15,   15,   15,   16,   16,   17,   17,
                    18,   19,   19,   20,   20,   21,   21,   22,   23,   23,   24,   24,   25,   26,   27,   27,
                    28,   29,   29,   30,   31,   32,   32,   33,   34,   35,   36,   36,   37,   38,   39,   40,
                    41,   42,   43,   44,   45,   46,   47,   48,   49,   50,   51,   52,   53,   54,   55,   56,
                    58,   59,   60,   61,   62,   64,   65,   66,   67,   69,   70,   71,   73,   74,   76,   77,
                    78,   80,   81,   83,   84,   86,   87,   89,   90,   92,   94,   95,   97,   99,  100,  102,
                   104,  106,  107,  109,  111,  113,  115,  117,  118,  120,  122,  124,  126,  128,  130,  132,
                   134,  137,  139,  141,  143,  145,  147,  150,  152,  154,  156,  159,  161,  163,  166,  168,
                   171,  173,  175,  178,  180,  183,  186,  188,  191,  193,  196,  199,  201,  204,  207,  210,
                   212,  215,  218,  221,  224,  227,  230,  233,  236,  239,  242,  245,  248,  251,  254,  257,
                   260,  263,  267,  270,  273,  276,  280,  283,  286,  290,  293,  297,  300,  304,  307,  311,
                   314,  318,  321,  325,  328,  332,  336,  339,  343,  347,  351,  354,  358,  362,  366,  370,
                   374,  378,  381,  385,  389,  393,  397,  401,  405,  410,  414,  418,  422,  426,  430,  434,
                   439,  443,  447,  451,  456,  460,  464,  469,  473,  477,  482,  486,  491,  495,  499,  504,
                   508,  513,  517,  522,  527,  531,  536,  540,  545,  550,  554,  559,  563,  568,  573,  577,
                   582,  587,  592,  596,  601,  606,  611,  615,  620,  625,  630,  635,  640,  644,  649,  654,
                   659,  664,  669,  674,  678,  683,  688,  693,  698,  703,  708,  713,  718,  723,  728,  732,
                   737,  742,  747,  752,  757,  762,  767,  772,  777,  782,  787,  792,  797,  802,  806,  811,
                   816,  821,  826,  831,  836,  841,  846,  851,  855,  860,  865,  870,  875,  880,  884,  889,
                   894,  899,  904,  908,  913,  918,  923,  927,  932,  937,  941,  946,  951,  955,  960,  965,
                   969,  974,  978,  983,  988,  992,  997, 1001, 1005, 1010, 1014, 1019, 1023, 1027, 1032, 1036,
                  1040, 1045, 1049, 1053, 1057, 1061, 1066, 1070, 1074, 1078, 1082, 1086, 1090, 1094, 1098, 1102,
                  1106, 1109, 1113, 1117, 1121, 1125, 1128, 1132, 1136, 1139, 1143, 1146, 1150, 1153, 1157, 1160,
                  1164, 1167, 1170, 1174, 1177, 1180, 1183, 1186, 1190, 1193, 1196, 1199, 1202, 1205, 1207, 1210,
                  1213, 1216, 1219, 1221, 1224, 1227, 1229, 1232, 1234, 1237, 1239, 1241, 1244, 1246, 1248, 1251,
                  1253, 1255, 1257, 1259, 1261, 1263, 1265, 1267, 1269, 1270, 1272, 1274, 1275, 1277, 1279, 1280,
                  1282, 1283, 1284, 1286, 1287, 1288, 1290, 1291, 1292, 1293, 1294, 1295, 1296, 1297, 1297, 1298,
                  1299, 1300, 1300, 1301, 1302, 1302, 1303, 1303, 1303, 1304, 1304, 1304, 1304, 1304, 1305, 1305,
            ];

            var gaussOffset = voice.interpPos >> 4 & 0xFF;
            var fwdOffset = 255 - gaussOffset;
            var revOffset = gaussOffset;

            var brrOffset = voice.brrPos + ((voice.interpPos >> 12) & 0x7FFF);
            var output = (GAUSS_TABLE[fwdOffset +   0] * voice.brrBuffer[brrOffset + 0] +
                          GAUSS_TABLE[fwdOffset + 256] * voice.brrBuffer[brrOffset + 1] +
                          GAUSS_TABLE[revOffset + 256] * voice.brrBuffer[brrOffset + 2] +
                          GAUSS_TABLE[revOffset +   0] * voice.brrBuffer[brrOffset + 3]) >> 11;
            return output;
        }

        var counters = this._counters;
        function counterPoll(rate) {
            if (rate === 0)
                return false;
            return counters[COUNTER_SELECT[rate]] & COUNTER_MASK[rate];
        }

        var runVoice = function runVoice(voiceIdx) {
            var voiceBit = (1 << voiceIdx);
            var voice = this._voices[voiceIdx];

            var pitch = ((this._regs[voiceRegAddr(voiceIdx, VOICE_REG_PITCH_H)] & 0x3F) << 8) | this._regs[voiceRegAddr(voiceIdx, VOICE_REG_PITCH_L)];

            // KON phases
            if (voice.keyOnDelay > 0) {
                --voice.keyOnDelay;

                if (voice.keyOnDelay == 4) {
                    voice.sourceIndex = this._regs[voiceRegAddr(voiceIdx, VOICE_REG_SOURCE)];
                    voice.sampleAddr = getDirectoryEntry(voice.sourceIndex, DirEntry.START);
                    voice.brrPos = 0;
                }

                voice.envx = 0;
                voice.interpPos = (voice.keyOnDelay < 3) ? 0x4000 : 0;
                pitch = 0;
            }

            if (this._everyOtherSample) {
                if (this._keyOff & voiceBit)
                    voice.envelopeState = EnvelopeState.RELEASE;

                if (this._keyOn & voiceBit) {
                    voice.envelopeState = EnvelopeState.ATTACK;
                    voice.keyOnDelay = 5;
                }
            }

            var adsr0 = this._regs[voiceRegAddr(voiceIdx, VOICE_REG_ADSR0)];
            var adsr1 = this._regs[voiceRegAddr(voiceIdx, VOICE_REG_ADSR1)];

            function applyEnv(rate, step) {
                voice.newEnvx = voice.envx + step;

                if (voice.newEnvx > 0x7FF || voice.newEnvx < 0) {
                    voice.newEnvx = (voice.newEnvx < 0 ? 0 : 0x7FF);
                    if (voice.envelopeState == EnvelopeState.ATTACK)
                        voice.envelopeState = EnvelopeState.DECAY;
                }

                if (!counterPoll(rate))
                    voice.envx = voice.newEnvx;
            }

            // This is the same for both ADSR and GAIN modes.
            if (voice.keyOnDelay == 0) {
                if (voice.envelopeState == EnvelopeState.RELEASE) {
                    var step = -8;

                    // This does *not* go through the counter!
                    voice.newEnvx = (voice.envx += step);

                    // Early exit
                    if (voice.envx <= 0) {
                        voice.envx = voice.newEnvx = 0;
                        return 0;
                    }
                }

                if (adsr0 & 0x80) {
                    // Using ADSR mode.
                    if (voice.envelopeState == EnvelopeState.ATTACK) {
                        var rate = ((adsr0 & 0x0F) << 1) + 1;
                        var step = (rate == 0x31) ? 0x400 : 0x20;
                        applyEnv(rate, step);
                    } else if (voice.envelopeState == EnvelopeState.DECAY) {
                        var rate = (adsr0 >> 3 & 0x0E) + 0x10;
                        var step = -((voice.envx - -1) >> 8) + 1;
                        applyEnv(rate, step);
                        var sl = ((adsr1 >> 5) + 1) * 0x100;
                        if (voice.newEnvx <= sl)
                            voice.envelopeState = EnvelopeState.SUSTAIN;
                    } else if (voice.envelopeState == EnvelopeState.SUSTAIN) {
                        var rate = (adsr1 & 0x1F);
                        var step = -((voice.envx - -1) >> 8) + 1;
                        applyEnv(rate, step);
                    }
                } else {
                    // XXX: We don't support GAIN yet.
                    console.error("Unsupported: GAIN", voiceIdx, adsr0, voice.envelopeState);
                }
            }

            var oldPos = voice.interpPos;
            voice.interpPos = (oldPos & 0x3FFF) + pitch;

            if (oldPos >= 0x4000) {
                brrDecode(voice);
            }

            var output;

            if (voice.newEnvx > 0) {
                output = gaussianInterpolate(voice);
                output = ((output * voice.newEnvx) >> 11);
            } else {
                output = 0;
            }

            return output;
        }.bind(this);

        var keyOn, keyOff;
        var wp = this.wp;
        var dstL = this._buffer.getChannelData(0);
        var dstR = this._buffer.getChannelData(1);

        while (nSamples--) {
            var outputL = 0, outputR = 0;

            this._everyOtherSample = !this._everyOtherSample;
            if (this._everyOtherSample) {
                this._keyOn = this._regs[GLOBAL_REG_KEY_ON];
                this._regs[GLOBAL_REG_KEY_ON] = 0;

                this._keyOff = this._regs[GLOBAL_REG_KEY_OFF];
            }

            this._runCounter(1);
            this._runCounter(2);
            this._runCounter(3);

            for (var voiceIdx = 0; voiceIdx < 8; voiceIdx++) {
                var voice = this._voices[voiceIdx];
                var output = runVoice(voiceIdx);
                var volumeL = this._sregs[voiceRegAddr(voiceIdx, VOICE_REG_VOL_L)];
                var volumeR = this._sregs[voiceRegAddr(voiceIdx, VOICE_REG_VOL_R)];
                var l = output * volumeL;
                var r = output * volumeR;
                outputL += l;
                outputR += r;
            }

            var mainVolumeL = this._sregs[GLOBAL_REG_MASTER_VOL_L];
            var mainVolumeR = this._sregs[GLOBAL_REG_MASTER_VOL_R];

            var mainOutputL = clamp16((outputL * mainVolumeL) >> 14);
            var mainOutputR = clamp16((outputR * mainVolumeR) >> 14);

            dstL[wp] = mainOutputL / 0xFFFF;
            dstR[wp] = mainOutputR / 0xFFFF;
            ++wp;
        }

        this.wp = wp;
    };

    DSP.prototype.resetBuffer = function(buffer, offset) {
        this._buffer = buffer;
        this.wp = offset;
    };

    DSP.prototype.CLOCKS_PER_SAMPLE = CLOCKS_PER_SAMPLE;

    exports.SPC_DSP = DSP;

})(this);
