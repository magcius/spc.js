"use strict";

// The cycle counts of all the instructions in the CPU
const CYCLE_TABLE = [
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

// Flags in the PSW (Program Status Ward)
const FLAG_N = (1 << 7); // Negative
const FLAG_V = (1 << 6); // Overflow
const FLAG_P = (1 << 5); // Direct Page
const FLAG_B = (1 << 4); // Break
const FLAG_H = (1 << 3); // Half Carry
const FLAG_I = (1 << 2); // Indirect master enable
const FLAG_Z = (1 << 1); // Zero
const FLAG_C = (1 << 0); // Carry

// We track the N flag by using the nz value. It's 8-bits
// wide, with the top bit being the signed bit.
const NZ_NEG_MASK  = 0x80;

// Location of the stack in RAM
const STACK_OFFSET = 0x101;

// Additional MMIO registers
// 0xF0 is Unused
const FUNC_REGISTER_CONTROL  = 0xF1; // Control register
const FUNC_REGISTER_RADDR    = 0xF2; // DSP register address
const FUNC_REGISTER_RDATA    = 0xF3; // DSP register data
const FUNC_REGISTER_PORT0    = 0xF4; // Port-0
const FUNC_REGISTER_PORT1    = 0xF5; // Port-1
const FUNC_REGISTER_PORT2    = 0xF6; // Port-2
const FUNC_REGISTER_PORT3    = 0xF7; // Port-3
// 0xF8 is Unused
// 0xF9 is Unused
const FUNC_REGISTER_TIMER0   = 0xFA; // Timer-0
const FUNC_REGISTER_TIMER1   = 0xFB; // Timer-1
const FUNC_REGISTER_TIMER2   = 0xFC; // Timer-2
const FUNC_REGISTER_COUNTER0 = 0xFD; // Counter-0
const FUNC_REGISTER_COUNTER1 = 0xFE; // Counter-1
const FUNC_REGISTER_COUNTER2 = 0xFF; // Counter-2

class Timer {
    constructor(idx, rate) {
        this._idx = idx;
        this._rate = rate;
        this._enabled = false;
        this._time = 1;
    }
    loadFromRegs(enabled, divisor, counter) {
        this._enabled = !!enabled;
        this._divisor = divisor;
        this._counter = counter;
    }
    setEnabled(time, enabled) {
        enabled = !!enabled;

        if (this._enabled == enabled)
            return;

        this._runUntil(time);
        this._enabled = enabled;

        // The counter resets when it's turned on, as well.
        if (this._enabled)
            this._counter = 0;
    }
    setDivisor(time, divisor) {
        if (this._divisor == divisor)
            return;

        this._runUntil(time);
        this._divisor = divisor;
    }
    readCounter(time) {
        this._runUntil(time);
        // The counter resets when it's read.
        const val = this._counter;
        this._counter = 0;
        return val;
    }
    _runUntil(endTime) {
        const oldTime = this._time;
        this._time = endTime;
        if (!this._enabled)
            return;

        const divisor = this._divisor == 0 ? 256 : this._divisor;
        const oldAbsTicks = ((((oldTime / this._rate) | 0)) / divisor) | 0;
        const newAbsTicks = ((((endTime / this._rate) | 0)) / divisor) | 0;
        const nTicks = newAbsTicks - oldAbsTicks;

        this._counter += nTicks;
        // Keep it a four-bit counter.
        this._counter &= 0x0F;
    }
}

export class CPU {
    constructor(state) {
        this._state = state;
        this._time = 0;

        // For debugging
        this._instCounter = 0;

        this._timer0 = new Timer(0, 128);
        this._timer1 = new Timer(1, 128);
        this._timer2 = new Timer(2, 16);

        const ram = this._state.ram;
        const control = ram[FUNC_REGISTER_CONTROL];
        this._timer0.loadFromRegs(control & 0x01, ram[FUNC_REGISTER_TIMER0], ram[FUNC_REGISTER_COUNTER0]);
        this._timer1.loadFromRegs(control & 0x02, ram[FUNC_REGISTER_TIMER1], ram[FUNC_REGISTER_COUNTER1]);
        this._timer2.loadFromRegs(control & 0x04, ram[FUNC_REGISTER_TIMER2], ram[FUNC_REGISTER_COUNTER2]);
    }

    runUntil(endTime) {
        const dsp = this._dsp;
        const state = this._state;
        let time = this._time;

        // We don't update `state` at runtime, we simply read the
        // members we need and update those, and then when we're
        // done, read those back.

        const ram  = state.ram;
        const sram = new Int8Array(ram.buffer, ram.byteOffset, ram.byteLength);
        let pc   = state.pc;
        let sp   = state.sp;
        let a    = state.a;
        let x    = state.x;
        let y    = state.y;

        function getpsw() {
            let psw = state.psw & ~(FLAG_N | FLAG_Z | FLAG_C | FLAG_P | FLAG_V);
            psw |= c ? FLAG_C : 0;
            psw |= !(nz) ? FLAG_Z : 0;
            psw |= (nz & NZ_NEG_MASK) ? FLAG_N : 0;
            psw |= dp ? FLAG_P : 0;
            psw |= v ? FLAG_V : 0;
            return psw;
        }

        let nz, dp, c, v;

        function setpsw(psw) {
            // Negative / zero
            // We store both the negative and zero flags in one value -- if the value
            // is 0, then it's zero and not negative. If the value has the sign bit (0x80)
            // set, then it's considered negative.
            nz = !(psw & FLAG_Z) * ((psw & FLAG_N) ? NZ_NEG_MASK : 1);

            // Direct Page offset
            dp = (psw & FLAG_P) ? 0x100 : 0;
            // Carry
            c = !!(psw & FLAG_C);
            // Overflow
            v = (psw & FLAG_V);
        }

        setpsw(state.psw);

        const writeRegister = (addr) => {
            switch (addr) {
                case FUNC_REGISTER_RADDR:
                    break; // Do nothing
                case FUNC_REGISTER_RDATA:
                    const dspRegIndex = state.ram[FUNC_REGISTER_RADDR];
                    const value = state.ram[FUNC_REGISTER_RDATA];
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
        };

        // Unsigned read/write
        const read = (addr) => {
            if (addr == FUNC_REGISTER_RDATA) {
                const dspRegIndex = ram[FUNC_REGISTER_RADDR];
                ram[addr] = dsp.getRegister(dspRegIndex);
            } else if (addr == FUNC_REGISTER_COUNTER0) {
                ram[addr] = this._timer0.readCounter(time);
            } else if (addr == FUNC_REGISTER_COUNTER1) {
                ram[addr] = this._timer1.readCounter(time);
            } else if (addr == FUNC_REGISTER_COUNTER2) {
                ram[addr] = this._timer2.readCounter(time);
            }

            return ram[addr];
        };

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
            const v = get16(STACK_OFFSET + sp);
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
            const t = x + y + c;
            c = !!(t >> 8);
            nz = t & 0xFF;
            return nz;
        }
        function sbc(x, y) {
            return adc(x, ~y & 0xFF);
        }

        function leftPad(S, spaces, ch = '0') {
            S = '' + S;
            while (S.length < spaces)
                S = `${ch}${S}`;
            return S;
        }
    
        function hexzero(n, spaces) {
            let S = (n >>> 0).toString(16);
            return leftPad(S, spaces);
        }

        // Instruction fetch and dispatch
        while (time < endTime) {
            // Assume that we read two bytes by default, and fiddle in the
            // instruction bodies themselves if that's not the case...

            const op = ram[pc];
            const cycles = CYCLE_TABLE[op];

            // If we wouldn't have enough time to compconste the operation,
            // bail out early...
            if (time + cycles > endTime)
                break;

            time += cycles;

            pc++;
            let data = ram[pc++];

            this._instCounter++;
            // console.log(`i: ${leftPad(this._instCounter, 4)}, PC: ${hexzero(pc-1, 2)}, OP: ${hexzero(op, 2)}, Data: ${hexzero(data, 2)}, PSW: ${nz < 0 ? 'N' : '.'}${nz === 0 ? 'Z' : '.'}${c ? 'C' : '.'}`);
            // if (this._instCounter > 10000) XXX;

            let addr;

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
                case 0xF9: // MOV X, dp+Y
                    addr = dp + data + y;
                    x = nz = read(addr);
                    break;
                case 0xE9: // MOV X, labs
                    addr = data16(data);
                    x = nz = read(addr);
                    break;
                case 0x8D: // MOV Y, #imm
                    y = nz = data;
                    break;
                case 0xFB: // MOV Y, dp+X
                    addr = dp + data + x;
                    y = nz = read(addr);
                    break;
                case 0xEB: // MOV Y, dp
                    addr = dp + data;
                    y = nz = read(addr);
                    break;
                case 0xEC: // MOV Y, labs
                    addr = data16(data);
                    y = nz = read(addr);
                    break;

                // 2. 8-bit Data Transmission Commands. Group II
                case 0xC4: // MOV dp, A
                    addr = dp + data;
                    write(addr, a);
                    break;
                case 0xD4: // MOV dp+X, A
                    addr = dp + data + x;
                    write(addr, a);
                    break;
                case 0xC5: // MOV labs, A
                    addr = data16(data);
                    write(addr, a);
                    break;
                case 0xD5: // MOV labs+X, A
                    addr = data16(data) + x;
                    write(addr, a);
                    break;
                case 0xD6: // MOV labs+Y, A
                    addr = data16(data) + y;
                    write(addr, a);
                    break;
                case 0xD8: // MOV dp, X
                    addr = dp + data;
                    write(addr, x);
                    break;
                case 0xC9: // MOV labs, X
                    addr = data16(data);
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
                case 0xCC: // MOV labs, X
                    addr = data16(data);
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
                    write(dp + ram[pc++], read(dp + data));
                    break;
                case 0x8F: // MOV dp, #imm
                    addr = dp + ram[pc++];
                    write(addr, data);
                    break;

                // 4. 8-bit Arithmetic Operations
                case 0x68: // CMP A, #imm
                    nz = a - data;
                    c = nz >= 0;
                    break;
                case 0x64: // CMP A, dp
                    nz = a - read(dp + data);
                    c = nz >= 0;
                    break;
                case 0x74: // CMP A, dp+X
                    nz = a - read(dp + data + x);
                    c = nz >= 0;
                    break;
                case 0x65: // CMP A, labs
                    addr = data16(data);
                    nz = a - read(addr);
                    c = nz >= 0;
                    break;
                case 0x75: // CMP A, labs+X
                    addr = data16(data) + x;
                    nz = a - read(addr);
                    c = nz >= 0;
                    break;
                case 0x76: // CMP A, labs+Y
                    addr = data16(data) + y;
                    nz = a - read(addr);
                    c = nz >= 0;
                    break;
                case 0x69: // CMP dp(d), dp(s)
                    {
                        const srcaddr = dp + data;
                        const dstaddr = dp + ram[pc++];
                        nz = read(dstaddr) - read(srcaddr);
                        c = nz >= 0;
                    }
                    break;
                case 0x78: // CMP dp, #imm
                    addr = dp + ram[pc++];
                    nz = read(addr) - data;
                    c = nz >= 0;
                    break;
                case 0xC8: // CMP X, #imm
                    nz = x - data;
                    c = nz >= 0;
                    break;
                case 0x3E: // CMP X, dp
                    nz = x - read(dp + data);
                    c = nz >= 0;
                    break;
                case 0x1E: // CMP X, labs
                    addr = data16(data);
                    nz = x - read(addr);
                    c = nz >= 0;
                    break;
                case 0xAD: // CMP Y, #imm
                    nz = y - data;
                    c = nz >= 0;
                    break;
                case 0x7E: // CMP Y, dp
                    nz = y - read(dp + data);
                    c = nz >= 0;
                    break;
                case 0x5E: // CMP Y, labs
                    addr = data16(data);
                    nz = y - read(addr);
                    c = nz >= 0;
                    break;
                case 0xAD: // CMP Y, #imm
                    nz = y - data;
                    c = nz >= 0;
                    break;
                case 0x88: // ADC A, #imm
                    a = adc(a, data);
                    break;
                case 0x84: // ADC A, dp
                    addr = dp + data;
                    a = adc(a, read(addr));
                    break;
                case 0x94: // ADC A, dp+X
                    addr = dp + data + x;
                    a = adc(a, read(addr));
                    break;
                case 0x95: // ADC A, labs+X
                    addr = data16(data) + x;
                    a = adc(a, read(addr));
                    break;
                case 0x96: // ADC A, labs+y
                    addr = data16(data) + y;
                    a = adc(a, read(addr));
                    break;
                case 0x89: // ADC dp(d), dp(s)
                    {
                        const srcaddr = dp + data;
                        const dstaddr = dp + ram[pc++];
                        write(dstaddr, adc(read(dstaddr), read(srcaddr)));
                    }
                    break;
                case 0x98: // ADC dp, #imm
                    addr = dp + ram[pc++];
                    write(addr, adc(read(addr), data));
                    break;
                case 0xA8: // SBC A, #imm
                    a = sbc(a, data);
                    break;
                case 0xA4: // SBC A, dp
                    addr = dp + data + x;
                    a = sbc(a, read(addr));
                    break;
                case 0xB5: // SBC A, labs+X
                    addr = data16(data) + x;
                    a = sbc(a, read(addr));
                    break;
                case 0xB6: // SBC A, labs+Y
                    addr = data16(data) + y;
                    a = sbc(a, read(addr));
                    break;


                // 5. 8-bit Logic Operations
                case 0x28: // AND A, #imm
                    a = nz = (a & data);
                    break;
                case 0x24: // AND A, dp
                    a = nz = (a & read(dp + data));
                    break;
                case 0x34: // AND A, dp+X
                    a = nz = (a & read(dp + data + x));
                    break;
                case 0x25: // AND A, labs
                    addr = data16(data);
                    a = nz = (a & read(addr));
                    break;
                case 0x35: // AND A, labs+X
                    addr = data16(data) + x;
                    a = nz = (a & read(addr));
                    break;
                case 0x29: // AND dp(d), dp(s)
                    {
                        const srcaddr = dp + data;
                        const dstaddr = dp + ram[pc++];
                        nz = write(dstaddr, read(dstaddr) & read(srcaddr));
                    }
                    break;
                case 0x38: // AND dp, #imm
                    addr = dp + ram[pc++];
                    nz = write(addr, read(addr) & data);
                    break;
                case 0x08: // OR A, #imm
                    a = nz = (a | data);
                    break;
                case 0x04: // OR A, dp
                    a = nz = (a | read(dp + data));
                    break;
                case 0x14: // OR A, dp
                    a = nz = (a | read(dp + data + x));
                    break;
                case 0x15: // OR A, labs+X
                    addr = data16(data) + x;
                    a = nz = a | read(addr);
                    break;
                case 0x07: // OR A, [dp+X]
                    a = nz = (a | get16(dp + data));
                    a &= 0xFF;
                    break;
                    case 0x09: // OR dp(d), dp(s)
                    {
                        const dstaddr = dp + ram[pc++];
                        const srcaddr = dp + data;
                        nz = write(dstaddr, read(dstaddr) | read(srcaddr));
                    }
                    break;
                case 0x18: // OR dp, #imm
                    addr = dp + ram[pc++];
                    nz = write(addr, read(addr) | data);
                    break;
                case 0x48: // EOR A, #imm
                    a = nz = (a ^ data);
                    break;
                case 0x44: // EOR A, dp
                    a = nz = (a ^ read(dp + data));
                    break;
                case 0x58: // EOR dp, #imm
                    addr = dp + ram[pc++];
                    nz = write(addr, read(addr) ^ data);
                    break;

                // 6. Addition & Subtraction Commands
                case 0xBC: // INC A
                    ++a; nz = a; a &= 0xFF;
                    --pc;
                    break;
                case 0xAB: // INC dp
                    addr = dp + data;
                    nz = write(addr, read(addr) + 1);
                    break;
                case 0xBB: // INC dp+x
                    addr = dp + data + x;
                    nz = write(addr, read(addr) + 1);
                    break;
                case 0xAC: // INC labs
                    addr = data16(data);
                    nz = write(addr, read(addr) + 1);
                    break;
                case 0x3D: // INC X
                    ++x; nz = x; x &= 0xFF;
                    --pc;
                    break;
                case 0xFC: // INC Y
                    ++y; nz = y; y &= 0xFF;
                    --pc;
                    break;
                case 0x9C: // DEC A
                    --a; nz = a; a &= 0xFF;
                    --pc;
                    break;
                case 0x8B: // DEC dp
                    addr = dp + data;
                    nz = write(addr, read(addr) - 1);
                    break;
                case 0x9B: // DEC dp+X
                    addr = dp + data + x;
                    nz = write(addr, read(addr) - 1);
                    break;
                case 0x1D: // DEC X
                    --x; nz = x; x &= 0xFF;
                    --pc;
                    break;
                case 0xDC: // DEC Y
                    --y; nz = y; y &= 0xFF;
                    --pc;
                    break;

                // 7. Shift, Rotation Commands
                case 0x1C: // ASL A
                    {
                        a = a << 1;
                        c = a >> 8; nz = (a &= 0xFF);
                        --pc;
                    }
                    break;
                case 0x0B: // ASL dp
                    {
                        addr = dp + data;
                        let temp = read(addr) << 1;
                        c = temp >> 8; nz = (temp &= 0xFF);
                        write(addr, temp);
                    }
                    break;
                case 0x5C: // LSR A
                    {
                        c = a & 1;
                        a = a >> 1;
                        nz = (a &= 0xFF);
                        --pc;
                    }
                    break;
                case 0x4B: // LSR dp
                    {
                        addr = dp + data;
                        c = read(addr);
                        nz = write(addr, c >> 1);
                        c &= 1;
                    }
                    break;
                case 0x3C: // ROL A
                    {
                        const temp = +!!c;
                        c = a << 1;
                        a = nz = c | temp;
                        a &= 0xFF;
                        --pc;
                    }
                    break;
                case 0x2B: // ROL dp
                    {
                        addr = dp + data;
                        const temp = +!!c;
                        c = read(addr) << 1;
                        nz = write(addr, c | temp);
                    }
                    break;
                case 0x7C: // ROR A
                    {
                        const temp = +!!c << 8 | a;
                        c = temp & 1;
                        a = nz = temp >> 1;
                        --pc;
                    }
                    break;
                case 0x6B: // ROR dp
                    {
                        addr = dp + data;
                        const temp = +!!c << 8 | read(addr);
                        c = temp & 1;
                        nz = write(addr, temp >> 1);
                    }
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
                    {
                        const ya = get16(dp + data);
                        y = ya >> 8; a = ya & 0xFF;
                        c = ya >> 16; nz = y;
                    }
                    break;

                // 9. 16-bit Commands
                case 0x3A: // INCW dp
                    set16(dp + data, get16(dp + data) + 1);
                    --pc;
                    break;
                case 0x1A: // DECW dp
                    set16(dp + data, get16(dp + data) - 1);
                    --pc;
                    break;
                case 0x7A: // ADDW YA, dp
                    {
                        const ya = (y << 8) | a;
                        data = get16(dp + data);
                        c = 0;
                        const r = adc(ya & 0xFF, data & 0xFF) | (adc(ya >> 8, data >> 8)) << 8;
                        y = r >> 8; a = r & 0xFF;
                        nz = (r >> 16 | r != 0);
                    }
                    break;
                case 0x9A: // SUBW YA, dp
                    {
                        const ya = (y << 8) | a;
                        data = get16(dp + data);
                        c = 1;
                        const r = sbc(ya & 0xFF, data & 0xFF) | (sbc(ya >> 8, data >> 8)) << 8;
                        y = r >> 8; a = r & 0xFF;
                        nz = (r >> 16 | r != 0);
                    }
                    break;
                case 0x5A: // CMPW YA, dp
                    {
                        const ya = (y << 8) | a;
                        nz = ya - get16(dp + data);
                        c = 1;
                    }
                    break;

                // 10. Multiplication and Division Commands
                case 0xCF: // MUL YA
                    {
                        const ya = (y * a) & 0xFFFF;
                        y = ya >> 8; a = ya & 0xFF;
                        nz = y | a;
                        --pc;
                    }
                    break;
                case 0x9E: // DIV YA, X
                    {
                        v = (y >= x);
                        const ya = (y << 8) | a;
                        y = (ya % x) & 0xFF;
                        a = (ya / x) & 0xFF;
                        nz = a;
                        --pc;
                    }
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
                case 0x90: // BCC
                    branch(!c);
                    break;
                case 0x70: // BVS
                    branch(v);
                    break;
                case 0x50: // BVC
                    branch(!v);
                    break;
                case 0x30: // BMI
                    branch(nz & NZ_NEG_MASK);
                    break;
                case 0x10: // BPL
                    branch(!(nz & NZ_NEG_MASK));
                    break;
                case 0x03: // BBS1
                case 0x23: // BBS2
                case 0x43: // BBS3
                case 0x63: // BBS4
                case 0x83: // BBS5
                case 0xA3: // BBS6
                case 0xC3: // BBS7
                case 0xE3: // BBS8
                    {
                        const bit = 1 << (op >> 5);
                        addr = dp + data; pc++;
                        branch(read(addr) & bit);
                    }
                    break;
                case 0x13: // BBC1
                case 0x33: // BBC2
                case 0x53: // BBC3
                case 0x73: // BBC4
                case 0x93: // BBC5
                case 0xB3: // BBC6
                case 0xD3: // BBC7
                case 0xF3: // BBC8
                    {
                        const bit = 1 << (op >> 5);
                        addr = dp + data; pc++;
                        branch(!(read(addr) & bit));
                    }
                    break;
                case 0x2E: // CBNE dp, rel
                    addr = dp + data; pc++;
                    branch(a != read(addr));
                    break;
                case 0xDE: // CBNE dp+X, rel
                    addr = dp + data + x; pc++;
                    branch(a != read(addr));
                    break;
                case 0x6E: // DBNZ dp, rel
                    addr = dp + data; pc++;
                    branch(write(addr, read(addr) - 1) !== 0);
                    break;
                case 0xFE: // DBNZ Y, rel
                    --y; y &= 0xFF;
                    branch(y !== 0);
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
                case 0x01: // TCALL0
                case 0x11: // TCALL1
                case 0x21: // TCALL2
                case 0x31: // TCALL3
                case 0x41: // TCALL4
                case 0x51: // TCALL5
                case 0x61: // TCALL6
                case 0x71: // TCALL7
                case 0x81: // TCALL8
                case 0x91: // TCALL9
                case 0xA1: // TCALL10
                case 0xB1: // TCALL11
                case 0xC1: // TCALL12
                case 0xD1: // TCALL13
                case 0xE1: // TCALL14
                case 0xF1: // TCALL15
                    {
                        push16(pc+1);
                        pc = get16(0xFFDE - (op >>> 3));
                        break;
                    }
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
                case 0x0D: // PUSH PSW
                    push8(getpsw());
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
                case 0x8E: // POP PSW
                    setpsw(pop8());
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
                    {
                        const bit = 1 << (op >> 5);
                        addr = dp + data;
                        write(addr, read(addr) | bit);
                    }
                    break;
                case 0x12: // CLR1
                case 0x32: // CLR2
                case 0x52: // CLR3
                case 0x72: // CLR4
                case 0x92: // CLR5
                case 0xB2: // CLR6
                case 0xD2: // CLR7
                case 0xF2: // CLR8
                    {
                        const mask = ~(1 << (op >> 5));
                        addr = dp + data;
                        write(addr, read(addr) & mask);
                    }
                    break;
                case 0x0E: // TSET1 labs
                    {
                        addr = data16(data);
                        let t = get16(addr);
                        nz = (a - t);
                        t |= a;
                        write(addr, t);
                    }
                    break;
                case 0x4E: // TCLR1 labs
                    {
                        addr = data16(data);
                        let t = get16(addr);
                        nz = (a - t);
                        t &= ~a;
                        write(addr, t);
                    }
                    break;
                case 0x8A: // EOR1 C, mem.bit
                    {
                        addr = data16(data);
                        const temp = get16(addr), bit = temp >>> (addr >>> 13);
                        c ^= bit;
                    }
                case 0xAA: // MOV1 C, mem.bit
                    {
                        addr = data16(data);
                        const temp = get16(addr), bit = temp >>> (addr >>> 13);
                        c = bit;
                    }
                    break;

                // 16. Program Status Flag Commands
                case 0x60: // CLRC
                    c = 0;
                    --pc;
                    break;
                case 0x80: // SETC
                    c = 1;
                    --pc;
                    break;
                case 0xED: // NOTC
                    c = !!c;
                    --pc;
                    break;
                case 0x20: // CLRP
                    dp = 0;
                    --pc;
                    break;
                case 0x40: // SETP
                    dp = 0x100;
                    --pc;
                    break;

                // 17. Other Commands
                case 0x00: // NOP
                    break;
                case 0xFF: // STOP
                    // ???
                    break;

                default:
                    console.error("unknown opcode", op.toString(16));
                    XXX;
                    break;
            }
        }

        state.pc = pc;
        state.sp = sp;
        state.a = a;
        state.x = x;
        state.y = y;

        // Pack the PSW back up.
        state.psw = getpsw();

        this._time = time;
        return this._time;
    }
}
