(function(exports) {
	"use strict";

    // The cycle counts of all the instructions in the CPU
    var CYCLE_TABLE = [
    //  0  1  2  3  4  5  6  7  8  9  A  B  C  D  E   F
        2, 8, 4, 7, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6,  8, // 0
        4, 8, 4, 7, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4,  6, // 1
        2, 8, 4, 7, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 7,  4, // 2
        4, 8, 4, 7, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3,  8, // 3
        2, 8, 4, 7, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 6,  6, // 4
        4, 8, 4, 7, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4,  3, // 5
        2, 8, 4, 7, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 7,  5, // 6
        4, 8, 4, 7, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3,  6, // 7
        2, 8, 4, 7, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4,  5, // 8
        4, 8, 4, 7, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 12, 5, // 9
        3, 8, 4, 7, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4,  4, // A
        4, 8, 4, 7, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3,  4, // B
        3, 8, 4, 7, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4,  9, // C
        4, 8, 4, 7, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 8,  3, // D
        2, 8, 4, 7, 3, 4, 3, 6, 2, 4, 5, 3, 4, 3, 4,  0, // E
        4, 8, 4, 7, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 6,  0, // F
    ];

    var BYTE_COUNTS = [
    //  0  1  2  3  4  5  6  7  8  9  A  B  C  D  E   F
        1, 1, 2, 3, 2, 3, 1, 2, 2, 3, 3, 2, 3, 1, 3,  1, // 0
        2, 1, 2, 3, 2, 3, 3, 2, 3, 1, 2, 2, 1, 1, 3,  3, // 1
        1, 1, 2, 3, 2, 3, 1, 2, 2, 3, 3, 2, 3, 1, 3,  2, // 2
        2, 1, 2, 3, 2, 3, 3, 2, 3, 1, 2, 2, 3, 1, 3,  2, // 3
    ];

    // Debugging infrastructure
    var TRACE = false;

    // Flags in the PSW (Program Status Ward)
    var FLAG_N = (1 << 7); // Negative
    var FLAG_V = (1 << 6); // Overflow
    var FLAG_P = (1 << 5); // Direct Page
    var FLAG_B = (1 << 4); // Break
    var FLAG_H = (1 << 3); // Half Carry
    var FLAG_I = (1 << 2); // Indirect master enable
    var FLAG_Z = (1 << 1); // Zero
    var FLAG_C = (1 << 0); // Carry

    // We track the N flag by using the nz value. It's 8-bits
    // wide, with the top bit being the signed bit.
    var NZ_NEG_MASK  = 0x80;

    // Location of the stack in RAM
    var STACK_OFFSET = 0x101;

    // Additional MMIO registers
    // 0xF0 is Unused
    var FUNC_REGISTER_CONTROL  = 0xF1; // Control register
    var FUNC_REGISTER_RADDR    = 0xF2; // DSP register address
    var FUNC_REGISTER_RDATA    = 0xF3; // DSP register data
    var FUNC_REGISTER_PORT0    = 0xF4; // Port-0
    var FUNC_REGISTER_PORT1    = 0xF5; // Port-1
    var FUNC_REGISTER_PORT2    = 0xF6; // Port-2
    var FUNC_REGISTER_PORT3    = 0xF7; // Port-3
    // 0xF8 is Unused
    // 0xF9 is Unused
    var FUNC_REGISTER_TIMER0   = 0xFA; // Timer-0
    var FUNC_REGISTER_TIMER1   = 0xFB; // Timer-1
    var FUNC_REGISTER_TIMER2   = 0xFC; // Timer-2
    var FUNC_REGISTER_COUNTER0 = 0xFD; // Counter-0
    var FUNC_REGISTER_COUNTER1 = 0xFE; // Counter-1
    var FUNC_REGISTER_COUNTER2 = 0xFF; // Counter-2

	/*
	function loadoutb() {
		var req = new XMLHttpRequest();
		req.open('GET', 'inst.txt', false);
		req.overrideMimeType('text/plain');
		req.send();
		return req.response.split('\n');
	}
	var outb = loadoutb();
	*/

	function Timer(idx, rate) {
		this._idx = idx;
		this._rate = rate;
		this._enabled = false;
		this._time = 1;
	}
	Timer.prototype.loadFromRegs = function(enabled, divisor, counter) {
		this._enabled = !!enabled;
		this._divisor = divisor;
		this._counter = counter;
	};
	Timer.prototype.setEnabled = function(time, enabled) {
		enabled = !!enabled;

		if (this._enabled == enabled)
			return;

		this._runUntil(time);
		this._enabled = enabled;

		// The counter resets when it's turned on, as well.
		if (this._enabled)
			this._counter = 0;
	};
	Timer.prototype.setDivisor = function(time, divisor) {
		if (this._divisor == divisor)
			return;

		this._runUntil(time);
		this._divisor = divisor;
	};
	Timer.prototype.readCounter = function(time) {
		this._runUntil(time);
		// The counter resets when it's read.
		var val = this._counter;
		this._counter = 0;
		return val;
	};
	Timer.prototype._runUntil = function(endTime) {
		var oldTime = this._time;
		this._time = endTime;
		if (!this._enabled)
			return;

		var divisor = this._divisor == 0 ? 256 : this._divisor;
		var oldAbsTicks = ((((oldTime / this._rate) | 0)) / divisor) | 0;
		var newAbsTicks = ((((endTime / this._rate) | 0)) / divisor) | 0;
		var nTicks = newAbsTicks - oldAbsTicks;

		if (TRACE)
			console.log("Running Timer", oldTime / this._rate, endTime / this._rate, nTicks);

		this._counter += nTicks;
		// Keep it a four-bit counter.
		this._counter &= 0x0F;
	};

    function CPU(state, dsp) {
        this._state = state;
        this._dsp = dsp;
        this._time = 0;

        // For debugging
        this._instCounter = 0;

		this._timer0 = new Timer(0, 128);
		this._timer1 = new Timer(1, 128);
		this._timer2 = new Timer(2, 16);

		var ram = this._state.ram;
		var control = ram[FUNC_REGISTER_CONTROL];
		this._timer0.loadFromRegs(control & 0x01, ram[FUNC_REGISTER_TIMER0], ram[FUNC_REGISTER_COUNTER0]);
		this._timer1.loadFromRegs(control & 0x02, ram[FUNC_REGISTER_TIMER1], ram[FUNC_REGISTER_COUNTER1]);
		this._timer2.loadFromRegs(control & 0x04, ram[FUNC_REGISTER_TIMER2], ram[FUNC_REGISTER_COUNTER2]);
    }

    CPU.prototype.runUntil = function(endTime) {
        var dsp = this._dsp;
        var state = this._state;
        var time = this._time;

        // We don't update `state` at runtime, we simply read the
        // members we need and update those, and then when we're
        // done, read those back.

        // Negative / zero
		// We store both the negative and zero flags in one value -- if the value
		// is 0, then it's zero and not negative. If the value has the sign bit (0x80)
		// set, then it's considered negative.
        var nz = !(state.psw & FLAG_Z) * ((state.psw & FLAG_N) ? NZ_NEG_MASK : 1);

        // Direct Page offset
        var dp = (state.psw & FLAG_P) ? 0x100 : 0;
        // Carry
        var c = (state.psw & FLAG_C);

        var ram  = state.ram;
        var sram = new Int8Array(ram.buffer, ram.byteOffset, ram.byteLength);
        var pc   = state.pc;
        var sp   = state.sp;
        var a    = state.a;
        var x    = state.x;
        var y    = state.y;

        function runDSP() {
            dsp.runUntil(time);
        }

        var writeRegister = function(addr) {
            switch (addr) {
                case FUNC_REGISTER_RADDR:
                    break; // Do nothing
                case FUNC_REGISTER_RDATA:
                    var dspRegIndex = state.ram[FUNC_REGISTER_RADDR];
					var value = state.ram[FUNC_REGISTER_RDATA];

                    // Catch the DSP up to everything we did so far.
                    runDSP();

                    dsp.setRegister(dspRegIndex, value);
                    break;
				case FUNC_REGISTER_PORT0:
				case FUNC_REGISTER_PORT1:
				case FUNC_REGISTER_PORT2:
				case FUNC_REGISTER_PORT3:
					// Ports are unused in our SPC player
					break;
				case FUNC_REGISTER_TIMER0:
					return this._timer0.setDivisor(time, state.ram[addr]);
				case FUNC_REGISTER_TIMER1:
					return this._timer1.setDivisor(time, state.ram[addr]);
				case FUNC_REGISTER_TIMER2:
					return this._timer2.setDivisor(time, state.ram[addr]);
				case FUNC_REGISTER_CONTROL:
					this._timer0.setEnabled(time, state.ram[addr] & 0x01);
					this._timer1.setEnabled(time, state.ram[addr] & 0x02);
					this._timer2.setEnabled(time, state.ram[addr] & 0x04);
					break;
                default:
                    console.error("Write to unimplemented register: ", addr.toString(16));
            }
        }.bind(this);

        // Unsigned read/write
        var read = function(addr) {
			if (addr == FUNC_REGISTER_RDATA) {
				runDSP();
				var dspRegIndex = ram[FUNC_REGISTER_RADDR];
				ram[addr] = dsp.getRegister(dspRegIndex);
			} else if (addr == FUNC_REGISTER_COUNTER0) {
				ram[addr] = this._timer0.readCounter(time);
			} else if (addr == FUNC_REGISTER_COUNTER1) {
				ram[addr] = this._timer1.readCounter(time);
			} else if (addr == FUNC_REGISTER_COUNTER2) {
				ram[addr] = this._timer2.readCounter(time);
			}

            return ram[addr];
        }.bind(this);

        function write(addr, value) {
            ram[addr] = value;
            if (addr >= 0xF0 && addr <= 0xFF)
                writeRegister(addr);
			return value;
        }

        // Signed read/write
        function read_s(addr) {
            return sram[addr];
        }

        function get16(addr) {
            return (read(addr+1) << 8) | read(addr);
        }

        function set16(addr, v) {
            write(addr+1, v >> 8);
            write(addr,   v & 0x00FF);
        }

        function pop16() {
            var v = get16(STACK_OFFSET + sp);
            sp += 2;
            return v;
        }

        function push16(v) {
            sp -= 2;
            set16(STACK_OFFSET + sp, v);
        }

        function pop8() {
            return ram[STACK_OFFSET + sp++];
        }

        function push8(v) {
            ram[STACK_OFFSET + --sp] = v;
        }

        function data16(data) {
            return (ram[pc++] << 8) | data;
        }

		function branch(cond) {
			if (cond)
				pc += read_s(pc - 1);
			else
				time -= 2;
		}

		function adc(x, y) {
			var t = x + y + c;
			c = !!(t >> 8);
			nz = t & 0xFF;
			return nz;
		}
		function sbc(x, y) {
			return adc(x, ~y & 0xFF);
		}

        // Instruction fetch and dispatch
        while (time < endTime) {
            // Assume that we read two bytes by default, and fiddle in the
            // instruction bodies themselves if that's not the case...

            var op = ram[pc];
            var cycles = CYCLE_TABLE[op];

            // If we wouldn't have enough time to complete the operation,
            // bail out early...
            if (time + cycles > endTime)
                break;

            time += cycles;

            if (TRACE) {
				var line = ['INST', this._instCounter, time, pc.toString(16), op.toString(16), (nz & NZ_NEG_MASK) ? "n" : " ", (!nz) ? "z" : " ", c ? "c" : " ", a, x, y].join(' ');
				console.log(line, this._instCounter);
				if (line != outb[this._instCounter]) {
					console.log("CPU MISMATCH!");
					console.log(line);
					console.log(outb[this._instCounter]);
					XXX
				}

                this._instCounter++;
            }

            pc++;
            var data = ram[pc++];

            var addr;

            switch (op) {
                // 1. 8-bit Data Transmission Commands. Group I
                case 0xE8: // MOV A, #imm
                    a = nz = data;
                    break;
                case 0xE6: // MOV A, X
                    addr = dp + x;
                    a = nz = read(addr);
                    pc--;
                    break;
                case 0xE4: // MOV A, dp
                    addr = dp + data;
                    a = nz = read(addr);
                    break;
                case 0xF4: // MOV A, dp+X
                    addr = dp + data + x;
                    a = nz = read(addr);
                    break;
                case 0xE5: // MOV A, labs
                    addr = data16(data);
                    a = nz = read(addr);
                    break;
                case 0xF5: // MOV A, labs+X
                    addr = data16(data) + x;
                    a = nz = read(addr);
                    break;
                case 0xF6: // MOV A, labs+Y
                    addr = data16(data) + y;
                    a = nz = read(addr);
                    break;
                case 0xE7: // MOV A, (dp+X)
                    addr = get16(dp + data + x);
                    a = nz = read(addr);
                    break;
                case 0xF7: // MOV A, (dp)+Y
                    addr = get16(dp + data) + y;
                    a = nz = read(addr);
                    break;
				case 0xCD: // MOV X, #imm
	                x = nz = data;
	                break;
                case 0xF8: // MOV X, dp
                    addr = dp + data;
                    x = nz = read(addr);
                    break;
                case 0x8D: // MOV Y, #imm
                    y = nz = data;
                    break;
                case 0xFB: // MOV Y, dp+X
                    addr = dp + data + x;
                    y = nz = read(addr);
                    break;
				case 0xEC: // MOV Y, labs
                    addr = data16(data);
                    y = nz = read(addr);
                    break;

                // 2. 8-bit Data Transmission Commands. Group II
                case 0xD4: // MOV dp+X, A
                    addr = dp + data + x;
                    write(addr, a);
                    break;
                case 0xC4: // MOV dp, A
                    addr = dp + data;
                    write(addr, a);
                    break;
                case 0xD5: // MOV labs+X, A
                    addr = dp + data16(data) + x;
                    write(addr, a);
                    break;
                case 0xD6: // MOV labs+Y, A
                    addr = dp + data16(data) + y;
                    write(addr, a);
                    break;
                case 0xC9: // MOV labs, X
                    addr = dp + data16(data);
                    write(addr, x);
                    break;
                case 0xCB: // MOV dp, Y
                    addr = dp + data;
                    write(addr, y);
                    break;
                case 0xDB: // MOV dp+X, Y
                    addr = dp + data + x;
                    write(addr, y);
                    break;

                // 3. 8-bit Data Transmission Commands. Group III
                case 0x7D: // MOV A, X
                    a = nz = x;
                    --pc;
                    break;
				case 0xDD: // MOV A, Y
					a = nz = y;
					--pc;
					break;
                case 0x5D: // MOV X, A
                    x = nz = a;
                    --pc;
                    break;
				case 0xFD: // MOV Y, A
					y = nz = a;
					--pc;
					break;
				case 0xFA: // MOV dp(d), dp(s)
					var srcaddr = dp + data;
					var dstaddr = dp + ram[pc++];
					write(dstaddr, read(srcaddr));
					break;
                case 0x8F: // MOV dp, #imm
                    addr = dp + ram[pc++];
                    write(addr, data);
                    break;

                // 4. 8-bit Arithmetic Operations
				case 0x68: // CMP A, #imm
                    nz = a - data;
					c = nz >= 0; nz &= 0xFF;
                    break;
				case 0x64: // CMP A, dp
	                nz = a - read(dp + data);
					c = nz >= 0; nz &= 0xFF;
	                break;
                case 0xC8: // CMP X, #imm
                    nz = x - data;
                    c = nz >= 0; nz &= 0xFF;
                    break;
				case 0x88: // ADC #imm
					a = adc(a, data);
					break;
				case 0x95: // ADC labs+X
					addr = dp + data16(data) + x;
					a = adc(a, read(addr));
					break;
				case 0x89: // ADC dp(d), dp(s)
					var srcaddr = dp + data;
					var dstaddr = dp + ram[pc++];
					write(dstaddr, adc(read(dstaddr), read(srcaddr)));
					break;

                // 5. 8-bit Logic Operations
                case 0x04: // OR A, dp
                    a = nz = (a | read(dp + data));
                    break;
                case 0x08: // OR A, #imm
                    a = nz = (a | data);
                    break;
                case 0x28: // AND A, #imm
                    a = nz = (a & data);
                    break;
				case 0x48: // EOR A, #imm
					a = nz = (a ^ data);
					break;

                // 6. Addition & Subtraction Commands
                case 0xBC: // INC A
                    ++a; nz = (a &= 0xFF);
                    --pc;
                    break;
                case 0x3D: // INC X
                    ++x; nz = (x &= 0xFF);
                    --pc;
                    break;
                case 0xFC: // INC Y
                    ++y; nz = (y &= 0xFF);
                    --pc;
                    break;
                case 0x9C: // DEC A
                    --a; nz = (a &= 0xFF);
                    --pc;
                    break;
                case 0x1D: // DEC X
                    --x; nz = (x &= 0xFF);
                    --pc;
                    break;
                case 0xDC: // DEC Y
                    --y; nz = (y &= 0xFF);
                    --pc;
                    break;
                case 0x9B: // DEC dp+X
                    addr = dp + data + x;
                    nz = write(addr, read(addr) - 1);
                    break;
				case 0xAB: // INC dp
                    addr = dp + data;
                    nz = write(addr, read(addr) + 1);
                    break;
				case 0xBB: // INC dp+x
                    addr = dp + data + x;
                    nz = write(addr, read(addr) + 1);
                    break;

				// 7. Shift, Rotation Commands
                case 0x1C: // ASL A
					a = a << 1;
					c = a >> 8; nz = (a &= 0xFF);
                    --pc;
                    break;
				case 0x5C: // LSR A
					c = a & 0x01;
					a = a >> 1;
					nz = (a &= 0xFF);
                    --pc;
                    break;
				case 0x4B: // LSR dp
					addr = dp + data;
					nz = write(addr, read(addr) >> 1);
					c = 0;
					break;
				case 0x7C: // ROR A
					var temp = (c & 1) << 8 | a;
					c = temp & 1;
					a = nz = temp >> 1;
					--pc;
					break;
				case 0x6B: // ROR dp
					addr = dp + data;
					var temp = (c & 1) << 8 | read(addr);
					c = temp & 1;
					nz = write(addr, temp >> 1);
					break;
                case 0x9F: // XCN
                    a = nz = (a >> 4) | (a << 4);
                    --pc;
                    break;

                // 8. 16-bit Transition Commands
                case 0xDA: // MOVW dp, YA
                    write(dp + data, a);
                    write(dp + data + 1, y);
                    break;
				case 0xBA: // MOVW YA, dp
					var ya = get16(dp + data);
                    y = ya >> 8; a = ya & 0xFF;
					c = ya >> 16; nz = y;
					break;

                // 9. 16-bit Commands
                case 0x7A: // ADDW YA, dp
                    var ya = (y << 8) | a;
					data = get16(dp + data);
					c = 0;
					var r = adc(ya & 0xFF, data & 0xFF) | (adc(ya >> 8, data >> 8)) << 8;
					y = r >> 8; a = r & 0xFF;
					nz = (r >> 16 | r != 0);
                    break;
				case 0x9A: // SUBW YA, dp
					var ya = (y << 8) | a;
					data = get16(dp + data);
					c = 1;
					var r = sbc(ya & 0xFF, data & 0xFF) | (sbc(ya >> 8, data >> 8)) << 8;
					y = r >> 8; a = r & 0xFF;
					nz = (r >> 16 | r != 0);
					break;

				// 10. Multiplication and Division Commands
				case 0xCF: // MUL YA
					var ya = (y * a) & 0xFFFF;
                    nz = y = ya >> 8; a = ya & 0xFF;
					y &= 0xFF;
					--pc;
					break;
				case 0x9E: // DIV YA, X
					var ya = (y << 8) | a;
					y = (ya % x) & 0xFF;
					a = (ya / x) & 0xFF;
					nz = a;
					--pc;
					break;

                // 12. Branching Commands
                case 0x2F: // BRA
					branch(true);
                    break;
                case 0xF0: // BEQ
					branch(!nz);
                    break;
                case 0xD0: // BNE
					branch(nz);
                    break;
				case 0xB0: // BCS
					branch(c);
					break;
                case 0x30: // BMI
                    branch(nz & NZ_NEG_MASK);
                    break;
                case 0x10: // BPL
                    branch(!(nz & NZ_NEG_MASK));
                    break;
                case 0x5F: // JMP labs
                    pc = data16(data);
                    break;
                case 0x1F: // JMP (labs+X)
                    addr = get16(data16(data) + x);
                    pc = addr;
                    break;

                // 13. Sub-routine Call/Return Commands
                case 0x3F: // CALL
                    push16(pc+1);
                    pc = data16(data);
                    break;
                case 0x6F: // RET
                    pc = pop16();
                    break;

                // 14. Stack Commands
                case 0x2D: // PUSH A
                    push8(a);
                    --pc;
                    break;
                case 0x4D: // PUSH X
                    push8(x);
                    --pc;
                    break;
                case 0x6D: // PUSH Y
                    push8(y);
                    --pc;
                    break;
                case 0xAE: // POP A
                    a = pop8();
                    --pc;
                    break;
                case 0xCE: // POP X
                    x = pop8();
                    --pc;
                    break;
                case 0xEE: // POP Y
                    y = pop8();
                    --pc;
                    break;

                // 15. Bit Operation Commands
                case 0x02: // SET1
                case 0x22: // SET2
                case 0x42: // SET3
                case 0x62: // SET4
                case 0x82: // SET5
                case 0xA2: // SET6
                case 0xC2: // SET7
                case 0xE2: // SET8
                    var bit = 1 << (op >> 5);
                    addr = dp + data;
                    write(addr, read(addr) | bit);
                    break;
                case 0x12: // CLR1
                case 0x32: // CLR2
                case 0x52: // CLR3
                case 0x72: // CLR4
                case 0x92: // CLR5
                case 0xB2: // CLR6
                case 0xD2: // CLR7
                case 0xF2: // CLR8
                    var mask = ~(1 << (op >> 5));
                    addr = dp + data;
                    write(addr, read(addr) & mask);
                    break;

                // 16. Program Status Flag Commands
                case 0x20: // CLRP
                    dp = 0;
                    --pc;
                    break;
				case 0x60: // CLRC
					c = 0;
					--pc;
					break;
                case 0x40: // SETP
                    dp = 0x100;
                    --pc;
                    break;

                default:
                    console.error("unknown opcode", op.toString(16));
					if (TRACE) XXX
                    break;
            }
        }

        // Catch up the DSP
        runDSP();

        state.pc = pc;
        state.sp = sp;
        state.a = a;
        state.x = x;
        state.y = y;

		// Pack the PSW back up.
        state.psw &= ~(FLAG_N | FLAG_Z | FLAG_C | FLAG_P);
		state.psw |= c ? FLAG_C : 0;
		state.psw |= !(nz) ? FLAG_Z : 0;
		state.psw |= (nz & NZ_NEG_MASK) ? FLAG_N : 0;
		state.psw |= dp ? FLAG_P : 0;

		// console.log(state.psw);

        this._time = time;
        return this._time;
    };

    exports.SPC.CPU = CPU;

})(window);
