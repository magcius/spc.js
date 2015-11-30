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
        // var boot_rom = mmap(stream, 128);

        var dsp = new SPC.DSP(state);
        var cpu = new SPC.CPU(state, dsp);

        var t = 0;
        function go() {
            cpu.runUntil(t += (32000 * 1));
            setTimeout(go, 20);
        }
        go();

        /*
        var blobParts = [];
        for (var i = 0; i < 4; i++) {
            cpu.runUntil(t += (32000 * 200));
            var blobPart = dsp._obuf.buffer.slice(0, dsp._ringBufferWP * 2 * 2);
            blobParts.push(blobPart);
            dsp._ringBufferWP = 0;
        }

        var blob = new Blob(blobParts, { type: 'application/octet-stream' });
        downloadBlob("wsamples.bin", blob);
        */
    }

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

        /*
        var req1 = fetch("samples.bin");
        req1.onload = function() {
            var smps = new DataView(req1.response);
            var smpoff = 0x10;
            window.checksmp = function(l, r) {
                var sl = smps.getInt16(smpoff, true);
                if (l != sl) { console.log("MISMATCH L", smpoff.toString(16), l, sl, smps.getUint8(smpoff).toString(16), smps.getUint8(smpoff+1).toString(16)); XXX }
                smpoff += 2;
                var sr = smps.getInt16(smpoff, true);
                if (r != sr) { console.log("MISMATCH R", smpoff.toString(16), r, sr); XXX }
                smpoff += 2;
            };
        };
        */
    };

    exports.SPC = {};

})(window);
