/*
 * isa.js — Single source of truth for the Battle Bot assembly language.
 *
 * The assembler validates operands against these tables, the VM looks up
 * instruction costs here, and the in-app reference / docs/LANGUAGE.md are
 * generated from them, so documentation can never drift from behaviour.
 */
(function (BB) {
  'use strict';

  /** Simulation constants. Units: arena units, degrees, ticks. */
  const CONFIG = {
    ARENA_W: 800,
    ARENA_H: 600,
    ROBOT_RADIUS: 16,
    MAX_HEALTH: 100,

    CYCLES_PER_TICK: 50,   // identical instruction budget for every robot
    NUM_REGS: 8,           // R0..R7
    MEMORY_SIZE: 256,      // words, addresses 0..255
    STACK_SIZE: 64,        // shared by PUSH/POP and CALL/RET

    MAX_SPEED: 5,          // units per tick, forward
    MAX_REVERSE: -3,       // units per tick, backward
    ACCELERATION: 0.5,     // speed change per tick
    BODY_TURN_RATE: 8,     // degrees per tick
    TURRET_TURN_RATE: 20,  // degrees per tick

    FIRE_COOLDOWN: 15,     // ticks between shots
    BULLET_SPEED: 10,      // units per tick
    BULLET_DAMAGE: 10,

    SCAN_MAX_WIDTH: 90,    // degrees
    RADAR_RANGE: 250,      // units

    MAX_TICKS: 6000,       // time limit; highest health wins after this
  };

  /*
   * Operand kinds:
   *   dst    — register (R0..R7) or memory ([5], [R1], [R1+4])
   *   src    — register, memory, number or .def constant
   *   target — label (or absolute instruction index)
   *   sensor — sensor name, see SENSORS below
   */
  const INSTRUCTIONS = [
    // ---- Data movement ----
    { op: 'MOV', args: ['dst', 'src'], group: 'Data', summary: 'dst = src', example: 'MOV R0, [R1+2]' },
    { op: 'PUSH', args: ['src'], group: 'Data', summary: 'Push value onto the stack (max 64 entries).', example: 'PUSH R3' },
    { op: 'POP', args: ['dst'], group: 'Data', summary: 'Pop the top of the stack into dst.', example: 'POP R3' },

    // ---- Arithmetic (32-bit signed integers) ----
    { op: 'ADD', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = dst + src', example: 'ADD R0, 5' },
    { op: 'SUB', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = dst - src', example: 'SUB R0, R1' },
    { op: 'MUL', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = dst * src', example: 'MUL R0, 3' },
    { op: 'DIV', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = dst / src, truncated toward zero. Division by zero faults.', example: 'DIV R0, 2' },
    { op: 'MOD', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = dst mod src. Result takes the sign of src, so MOD R0, 360 always gives 0..359.', example: 'MOD R0, 360' },
    { op: 'INC', args: ['dst'], group: 'Arithmetic', summary: 'dst = dst + 1', example: 'INC R2' },
    { op: 'DEC', args: ['dst'], group: 'Arithmetic', summary: 'dst = dst - 1', example: 'DEC R2' },
    { op: 'NEG', args: ['dst'], group: 'Arithmetic', summary: 'dst = -dst', example: 'NEG R1' },
    { op: 'ABS', args: ['dst'], group: 'Arithmetic', summary: 'dst = |dst|', example: 'ABS R1' },
    { op: 'MIN', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = min(dst, src)', example: 'MIN R0, 45' },
    { op: 'MAX', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = max(dst, src)', example: 'MAX R0, -45' },
    { op: 'AND', args: ['dst', 'src'], group: 'Arithmetic', summary: 'Bitwise AND', example: 'AND R0, 1' },
    { op: 'OR', args: ['dst', 'src'], group: 'Arithmetic', summary: 'Bitwise OR', example: 'OR R0, 4' },
    { op: 'XOR', args: ['dst', 'src'], group: 'Arithmetic', summary: 'Bitwise XOR', example: 'XOR R0, R0' },
    { op: 'RAND', args: ['dst', 'src'], group: 'Arithmetic', summary: 'dst = random integer in 0..src-1 (src must be > 0). Deterministic per match seed.', example: 'RAND R0, 360' },

    // ---- Math helpers (angles in degrees) ----
    { op: 'ATAN2', args: ['dst', 'src', 'src'], group: 'Math', summary: 'dst = angle of vector (dx = 3rd, dy = 2nd) in degrees 0..359, using the arena angle convention.', example: 'ATAN2 R0, R2, R1' },
    { op: 'SIN', args: ['dst', 'src'], group: 'Math', summary: 'dst = round(sin(src degrees) * 1000)', example: 'SIN R1, R0' },
    { op: 'COS', args: ['dst', 'src'], group: 'Math', summary: 'dst = round(cos(src degrees) * 1000)', example: 'COS R1, R0' },
    { op: 'SQRT', args: ['dst', 'src'], group: 'Math', summary: 'dst = floor(sqrt(src)). Negative input faults.', example: 'SQRT R0, R0' },
    { op: 'NORM', args: ['dst'], group: 'Math', summary: 'Wrap an angle into -180..179. Turns "target - current" into the shortest signed turn.', example: 'NORM R0' },

    // ---- Comparison and flow control ----
    { op: 'CMP', args: ['src', 'src'], group: 'Flow', summary: 'Compare a with b and remember the result for the next conditional jump.', example: 'CMP R0, 100' },
    { op: 'JMP', args: ['target'], group: 'Flow', summary: 'Jump unconditionally.', example: 'JMP loop' },
    { op: 'JE', args: ['target'], group: 'Flow', summary: 'Jump if a == b (last CMP).', example: 'JE found' },
    { op: 'JNE', args: ['target'], group: 'Flow', summary: 'Jump if a != b.', example: 'JNE again' },
    { op: 'JL', args: ['target'], group: 'Flow', summary: 'Jump if a < b.', example: 'JL too_close' },
    { op: 'JLE', args: ['target'], group: 'Flow', summary: 'Jump if a <= b.', example: 'JLE ready' },
    { op: 'JG', args: ['target'], group: 'Flow', summary: 'Jump if a > b.', example: 'JG far' },
    { op: 'JGE', args: ['target'], group: 'Flow', summary: 'Jump if a >= b.', example: 'JGE far' },
    { op: 'CALL', args: ['target'], group: 'Flow', summary: 'Push the return address and jump to a subroutine.', example: 'CALL dodge' },
    { op: 'RET', args: [], group: 'Flow', summary: 'Return from a subroutine (pops the return address).', example: 'RET' },
    { op: 'NOP', args: [], group: 'Flow', summary: 'Do nothing (costs one cycle).', example: 'NOP' },
    { op: 'WAIT', args: [], group: 'Flow', summary: 'End this robot\'s turn for the current tick. Unused cycles are lost.', example: 'WAIT' },
    { op: 'HALT', args: [], group: 'Flow', summary: 'Stop the program permanently. The robot keeps its last speed and heading.', example: 'HALT' },

    // ---- Robot control ----
    { op: 'GET', args: ['dst', 'sensor'], group: 'Robot', summary: 'Read a sensor value into dst (see the sensor table).', example: 'GET R0, HEALTH' },
    { op: 'SPEED', args: ['src'], group: 'Robot', summary: 'Set the desired speed (-3..5 units/tick, clamped). The robot accelerates at 0.5 per tick.', example: 'SPEED 5' },
    { op: 'TURN', args: ['src'], group: 'Robot', summary: 'Set the desired heading to current heading + src degrees. The body turns at most 8°/tick.', example: 'TURN -90' },
    { op: 'HEAD', args: ['src'], group: 'Robot', summary: 'Set the desired absolute heading in degrees. The body turns at most 8°/tick.', example: 'HEAD 180' },
    { op: 'AIM', args: ['src'], group: 'Robot', summary: 'Set the desired absolute turret angle. The turret turns at most 20°/tick, independently of the body.', example: 'AIM R1' },
    { op: 'FIRE', args: [], group: 'Robot', summary: 'Fire along the turret at the end of this tick if COOLDOWN is 0. Otherwise nothing happens.', example: 'FIRE' },
    { op: 'SCAN', args: ['src'], group: 'Robot', cost: 3, summary: 'Look for the nearest enemy inside a cone of src degrees (1..90) centred on the turret. Obstacles block the view. Updates the SCAN_* sensors; SCAN_DIST is -1 if nothing is found.', example: 'SCAN 20' },
    { op: 'RADAR', args: [], group: 'Robot', cost: 3, summary: 'Find the nearest enemy projectile within 250 units that is approaching you. Updates the THREAT_* sensors; THREAT_DIST is -1 if none.', example: 'RADAR' },
  ];

  const SENSORS = [
    { name: 'X', desc: 'Your x position (0 = left edge).' },
    { name: 'Y', desc: 'Your y position (0 = top edge).' },
    { name: 'HEADING', desc: 'Your current body heading, 0..359.' },
    { name: 'SPEED', desc: 'Your current speed (rounded).' },
    { name: 'HEALTH', desc: 'Remaining health, 0..100.' },
    { name: 'COOLDOWN', desc: 'Ticks until you can fire again (0 = ready).' },
    { name: 'TURRET', desc: 'Your current turret angle, 0..359.' },
    { name: 'SCAN_DIST', desc: 'Distance to the enemy found by the last SCAN, or -1.' },
    { name: 'SCAN_ANGLE', desc: 'Absolute angle from you to that enemy.' },
    { name: 'SCAN_X', desc: 'That enemy\'s x position.' },
    { name: 'SCAN_Y', desc: 'That enemy\'s y position.' },
    { name: 'SCAN_HEADING', desc: 'That enemy\'s heading (use it to lead your shots).' },
    { name: 'SCAN_SPEED', desc: 'That enemy\'s speed.' },
    { name: 'THREAT_DIST', desc: 'Distance to the projectile found by the last RADAR, or -1.' },
    { name: 'THREAT_ANGLE', desc: 'Absolute angle from you to that projectile.' },
    { name: 'THREAT_HEADING', desc: 'Direction that projectile is travelling.' },
    { name: 'FRONT', desc: 'Free distance ahead of your body (to a wall or obstacle) along your heading.' },
    { name: 'LAST_HIT', desc: 'Ticks since you were last hit by a projectile, or -1 if never.' },
    { name: 'TICK', desc: 'Current simulation tick.' },
    { name: 'ENEMIES', desc: 'Number of enemy robots still alive.' },
    { name: 'ARENA_W', desc: 'Arena width (800).' },
    { name: 'ARENA_H', desc: 'Arena height (600).' },
  ];
  SENSORS.forEach((s, i) => { s.id = i; });

  const INSTRUCTION_MAP = Object.create(null);
  for (const ins of INSTRUCTIONS) {
    if (ins.cost === undefined) ins.cost = 1;
    INSTRUCTION_MAP[ins.op] = ins;
  }
  const SENSOR_MAP = Object.create(null);
  for (const s of SENSORS) SENSOR_MAP[s.name] = s;

  const LANGUAGE_NOTES = [
    'Line 1 of a robot file is the robot\'s name. The program starts on line 2.',
    'Comments start with ; or #. Mnemonics, registers, labels and constants are case-insensitive.',
    'Labels end with a colon (`loop:`) and may share a line with an instruction.',
    'Constants: `.def NAME value`. They can be used anywhere a number is allowed, including memory offsets.',
    'Numbers are decimal (`-12`) or hexadecimal (`0x1F`). All values are 32-bit signed integers.',
    'Registers R0..R7 start at 0. Memory has 256 words ([0]..[255]), addressed as `[12]`, `[R1]` or `[R1+4]`.',
    'When execution runs past the last instruction it wraps to the first, so a program is an implicit loop.',
    `Each robot gets ${CONFIG.CYCLES_PER_TICK} cycles per tick. Most instructions cost 1 cycle; SCAN and RADAR cost 3. An infinite loop only uses up its own robot's budget.`,
    'Angles: 0° points right (east), 90° points down (south), increasing clockwise. Positions use screen coordinates with (0,0) at the top-left.',
    'Runtime errors such as division by zero or a stack overflow fault the robot. Its CPU stops and the robot keeps drifting with its last orders. Other robots are unaffected.',
  ];

  BB.CONFIG = CONFIG;
  BB.ISA = { INSTRUCTIONS, INSTRUCTION_MAP, SENSORS, SENSOR_MAP, LANGUAGE_NOTES };
})(globalThis.BB = globalThis.BB || {});
