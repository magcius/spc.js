(function(exports) {
    "use strict";

    function makeStream(buffer) {
        var stream = new DataView(buffer);
        stream.length = buffer.byteLength;
        stream.pos = 0;
        return stream;
    }

    function readByte(stream) {
        return stream.getUint8(stream.pos++);
    }

    function readWord(stream) {
        return stream.getUint16((stream.pos += 2) - 2, true);
    }

    function readLong(stream) {
        return stream.getUint32((stream.pos += 4) - 4, true);
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

    function downloadBlob(filename, blob) {
        var url = window.URL.createObjectURL(blob);
        var elem = document.createElement('a');
        elem.setAttribute('href', url);
        elem.setAttribute('download', filename);
        document.body.appendChild(elem);
        elem.click();
        document.body.removeChild(elem);
    }

    function makeWorker(modules, entryPoint) {
        var source = modules.map(o => o.toString()).concat(entryPoint);
        var blob = new Blob(sources, { type: 'text/javascript' });
        var url = window.URL.createObjectURL(blob);
        var w = new Worker(url);
        window.URL.revokeObjectURL(url);
        return w;
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

        var d = new Driver(state);
    }

    function Driver(state) {
        this._bufferSize = 8192;
        this._freeBuffers = [];

        this._ctx = new AudioContext();
        this._dsp = new SPC_DSP(state, this._buffer);
        this._cpu = new SPC_CPU(state, this._dsp);

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
        this._dsp.resetBuffer(buffer);
        this._cpu.runUntilSamples(this._bufferSize);

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

    function fetch(path) {
        var request = new XMLHttpRequest();
        request.open("GET", path, true);
        request.responseType = "arraybuffer";
        request.send();
        return request;
    }

    window.onload = function() {
        var req = fetch("brambles.spc");
        req.onload = function() {
            var stream = makeStream(req.response);
            loadSPC(stream);
        };
    };

})(window);
