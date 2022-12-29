"use strict";

import { CPU } from "./cpu.js";
import { DSP } from "./dsp.js";

function makeStream(buffer) {
    var stream = new DataView(buffer);
    stream.length = buffer.byteLength;
    stream.pos = 0;
    return stream;
}

function readByte(stream) {
    return stream.getUint8(stream.pos++);
}

function collect(stream, f, length) {
    var B = [];
    for (var i = 0; i < length; i++)
        B.push(f(stream));
    return B;
}

function readString(stream, length) {
    var B = collect(stream, readByte, length);
    return B.map(function(c) {
        return String.fromCharCode(c);
    }).join('');
}

function mmap(stream, length) {
    var buf = new Uint8Array(stream.buffer, stream.pos, length);
    stream.pos += length;
    return buf;
}

function invalid() {
    throw new Error("invalid");
}

function parseID666(stream) {
    function chop0(S) {
        var x = S.indexOf("\0");
        if (x == -1)
            return S;
        else
            return S.slice(0, x);
    }

    var id666 = {};
    id666.song = chop0(readString(stream, 32));
    id666.game = chop0(readString(stream, 32));
    id666.dumper = chop0(readString(stream, 16));
    id666.comments = chop0(readString(stream, 32));
    stream.pos += 11; // date
    stream.pos += 3; // len_secs
    stream.pos += 5; // fade_msecs
    id666.author = chop0(readString(stream, 32));
    id666.mute_mask = readByte(stream);
    id666.emulator = readByte(stream);
    stream.pos += 45; // unused
    return id666;
}

function loadSPC(stream) {
    var signature = readString(stream, 37);

    if (signature != "SNES-SPC700 Sound File Data v0.30\x1A\x1A\x1A\x1E")
        invalid();

    var spc = {};

    var state = {};
    var pcl = readByte(stream);
    var pch = readByte(stream);
    state.pc = (pch * 0x100) + pcl;
    state.a = readByte(stream);
    state.x = readByte(stream);
    state.y = readByte(stream);
    state.psw = readByte(stream);
    state.sp = readByte(stream);

    stream.pos += 2; // unused

    spc.id666 = parseID666(stream);
    state.ram = mmap(stream, 0x10000);
    state.regs = mmap(stream, 128);

    return new Driver(state);
}

function Driver(state) {
    this._bufferSize = 8192;
    this._freeBuffers = [];

    this._ctx = new AudioContext();
    this._cpu = new CPU(state);
    this._dsp = new DSP(state, this._cpu);

    this._playTime = this._ctx.currentTime;
    this._pumpAudio();
}
Driver.prototype._runCPU = function() {
    var buffer;
    if (this._freeBuffers.length) {
        buffer = this._freeBuffers.pop();
    } else {
        buffer = this._ctx.createBuffer(2, this._bufferSize, 32000);
    }

    const numSamples = this._bufferSize;
    const bufL = buffer.getChannelData(0);
    const bufR = buffer.getChannelData(1);
    for (let i = 0; i < numSamples; i++) {
        const [l, r] = this._dsp.runSample();
        bufL[i] = l;
        bufR[i] = r;
    }

    var bs = this._ctx.createBufferSource();
    bs.buffer = buffer;
    bs.connect(this._ctx.destination);
    bs.start(this._playTime);
    bs.onended = function() {
        this._freeBuffers.push(buffer);
        this._pumpAudio();
    }.bind(this);
    this._playTime += (this._bufferSize / 32000);
};
Driver.prototype._pumpAudio = function() {
    // Schedule 300ms or so in advance.
    while (this._playTime - this._ctx.currentTime < (300 / 1000))
        this._runCPU();
};
Driver.prototype.resume = function() {
    this._ctx.resume();
};

function fetch(path) {
    var request = new XMLHttpRequest();
    request.open("GET", path, true);
    request.responseType = "arraybuffer";
    request.send();
    return request;
}

window.onload = function() {
    var req = fetch("corn.spc");
    req.onload = function() {
        var stream = makeStream(req.response);
        const d = loadSPC(stream);
        document.onclick = function() {
            d.resume();
        };
    };
};
