/*
 * examples.js — Built-in example robots (also exported to examples/*.asm by
 * tools/build.js). Each one demonstrates a different strategy.
 */
(function (BB) {
  'use strict';

  const SENTINEL = `Sentinel
; STRATEGY: turret sniper.
; Holds its ground, sweeps the turret with a narrow scan, leads moving
; targets (predicts where they will be when the bullet arrives) and
; sidesteps any projectile that gets close.
;
; Memory: [0] = tick until which the current dodge continues

.def SWEEP_STEP   9      ; turret sweep per tick while searching
.def DODGE_RANGE  200
.def DODGE_TICKS  14

main:
    ; ---------- 1. Dodge incoming projectiles ----------
    RADAR
    GET  R0, THREAT_DIST
    CMP  R0, 0
    JL   calm
    CMP  R0, DODGE_RANGE
    JG   calm
    CALL dodge
    JMP  target
calm:
    GET  R0, TICK
    CMP  R0, [0]
    JL   target            ; still finishing a dodge
    SPEED 0                ; otherwise stand still

    ; ---------- 2. Find, lead and shoot ----------
target:
    SCAN 12
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   sweep
    CALL lead_aim          ; R6 = firing solution, turret already told to AIM
    GET  R1, TURRET
    SUB  R6, R1
    NORM R6
    ABS  R6
    CMP  R6, 6
    JG   done              ; turret still swinging into place
    GET  R1, COOLDOWN
    CMP  R1, 0
    JNE  done
    FIRE
    JMP  done
sweep:
    GET  R1, TURRET
    ADD  R1, SWEEP_STEP
    AIM  R1
done:
    WAIT
    JMP  main

; ------------------------------------------------------------------
; lead_aim: R6 = angle to where the scanned enemy will be when a bullet
; fired now reaches it.  lead = velocity * distance / BULLET_SPEED(10)
lead_aim:
    GET  R0, SCAN_DIST
    GET  R1, SCAN_HEADING
    GET  R2, SCAN_SPEED
    MUL  R2, R0            ; speed * distance
    COS  R3, R1
    MUL  R3, R2
    DIV  R3, 10000         ; / 1000 (COS scale) / 10 (bullet speed)
    SIN  R4, R1
    MUL  R4, R2
    DIV  R4, 10000
    GET  R5, SCAN_X
    ADD  R3, R5
    GET  R5, X
    SUB  R3, R5            ; R3 = predicted dx
    GET  R5, SCAN_Y
    ADD  R4, R5
    GET  R5, Y
    SUB  R4, R5            ; R4 = predicted dy
    ATAN2 R6, R4, R3
    AIM  R6
    RET

; ------------------------------------------------------------------
; dodge: move at right angles to the projectile's path, away from it.
; Drives backwards when that needs less turning.
dodge:
    GET  R1, THREAT_ANGLE
    ADD  R1, 180           ; bearing from the projectile to us
    GET  R2, THREAT_HEADING
    SUB  R1, R2
    NORM R1                ; > 0 : we are clockwise of its path
    MOV  R3, R2
    CMP  R1, 0
    JL   dodge_ccw
    ADD  R3, 90
    JMP  dodge_dir
dodge_ccw:
    SUB  R3, 90
dodge_dir:                 ; R3 = escape direction
    GET  R4, HEADING
    MOV  R5, R3
    SUB  R5, R4
    NORM R5
    ABS  R5
    CMP  R5, 90
    JG   dodge_back
    HEAD R3
    SPEED 5
    JMP  dodge_end
dodge_back:
    ADD  R3, 180
    HEAD R3
    SPEED -3
dodge_end:
    GET  R4, TICK
    ADD  R4, DODGE_TICKS
    MOV  [0], R4
    RET
`;

  const HUNTER = `Hunter
; STRATEGY: aggressive chaser.
; Sweeps a wide scan, charges at the nearest enemy and opens fire as soon
; as the turret lines up. Never dodges: it trusts speed and firepower.

.def CLOSE  80            ; stop charging inside this distance
.def ALIGN  8             ; max turret error (degrees) before firing

main:
    SCAN 60
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   search

    ; Target found: point body and turret at it.
    GET  R1, SCAN_ANGLE
    AIM  R1
    HEAD R1
    SPEED 5
    CMP  R0, CLOSE
    JG   fire_check
    SPEED 0                ; close enough; ramming hurts us too

fire_check:
    GET  R2, TURRET
    SUB  R2, R1
    NORM R2
    ABS  R2
    CMP  R2, ALIGN
    JG   end
    GET  R2, COOLDOWN
    CMP  R2, 0
    JNE  end
    FIRE
end:
    WAIT
    JMP  main

search:
    ; Spin the turret and roam, steering away from walls.
    GET  R1, TURRET
    ADD  R1, 45
    AIM  R1
    SPEED 3
    GET  R2, FRONT
    CMP  R2, 50
    JG   end
    TURN 120
    JMP  end
`;

  const DODGER = `Dodger
; STRATEGY: evasive skirmisher.
; Always on the move: bounces off walls, wanders randomly, swerves away
; from every incoming projectile, and snipes with an independent turret.

.def DODGE_RANGE 220
.def WALL_GAP    60

main:
    ; ---- 1. evade ----
    RADAR
    GET  R0, THREAT_DIST
    CMP  R0, 0
    JL   roam
    CMP  R0, DODGE_RANGE
    JG   roam
    CALL dodge
    JMP  gun

    ; ---- 2. roam ----
roam:
    SPEED 5
    GET  R0, FRONT
    CMP  R0, WALL_GAP
    JG   wander
    RAND R1, 90            ; wall ahead: turn 90..179 degrees
    ADD  R1, 90
    TURN R1
    JMP  gun
wander:
    RAND R1, 40            ; about once every 40 ticks...
    CMP  R1, 0
    JNE  gun
    RAND R1, 120           ; ...change course by -60..59 degrees
    SUB  R1, 60
    TURN R1

    ; ---- 3. shoot ----
gun:
    SCAN 24
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   gun_sweep
    GET  R1, SCAN_ANGLE
    AIM  R1
    GET  R2, TURRET
    SUB  R2, R1
    NORM R2
    ABS  R2
    CMP  R2, 10
    JG   end
    GET  R2, COOLDOWN
    CMP  R2, 0
    JNE  end
    FIRE
    JMP  end
gun_sweep:
    GET  R1, TURRET
    SUB  R1, 20
    AIM  R1
end:
    WAIT
    JMP  main

; dodge: steer perpendicular to the projectile, away from its path.
dodge:
    GET  R1, THREAT_ANGLE
    ADD  R1, 180           ; bearing from the projectile to us
    GET  R2, THREAT_HEADING
    SUB  R1, R2
    NORM R1
    CMP  R1, 0
    JL   dodge_ccw
    ADD  R2, 90
    JMP  dodge_go
dodge_ccw:
    SUB  R2, 90
dodge_go:
    HEAD R2
    SPEED 5
    RET
`;

  const ORBITER = `Orbiter
; STRATEGY: circle-strafer.
; Locks onto an enemy and orbits it at a preferred distance while firing.
; Moving sideways makes it hard to hit; reverses direction near walls.
;
; R7    = orbit direction: +90 clockwise, -90 counter-clockwise
; [0]   = tick of the last direction flip

.def RANGE       200
.def LOCK_WIDTH  16

    MOV  R7, 90
main:
    SCAN LOCK_WIDTH
    GET  R0, SCAN_DIST
    CMP  R0, 0
    JL   search

    GET  R1, SCAN_ANGLE
    AIM  R1
    ; distance correction = clamp((dist - RANGE) / 3, -60, 60)
    MOV  R2, R0
    SUB  R2, RANGE
    DIV  R2, 3
    MIN  R2, 60
    MAX  R2, -60
    ; heading = bearing + direction, bent inward when too far
    MOV  R3, R1
    ADD  R3, R7
    CMP  R7, 0
    JL   ccw
    SUB  R3, R2
    JMP  steer
ccw:
    ADD  R3, R2
steer:
    HEAD R3
    SPEED 5
    CALL walls
    ; fire when lined up
    GET  R2, TURRET
    SUB  R2, R1
    NORM R2
    ABS  R2
    CMP  R2, 8
    JG   end
    GET  R2, COOLDOWN
    CMP  R2, 0
    JNE  end
    FIRE
    JMP  end

search:
    GET  R1, TURRET
    ADD  R1, 15
    AIM  R1
    SPEED 2
    GET  R4, FRONT
    CMP  R4, 40
    JG   end
    TURN 90
end:
    WAIT
    JMP  main

; walls: if something is close ahead, slow down and flip the orbit
; direction (at most once every 30 ticks).
walls:
    GET  R4, FRONT
    CMP  R4, 40
    JG   walls_done
    SPEED 1
    GET  R5, TICK
    SUB  R5, [0]
    CMP  R5, 30
    JL   walls_done
    NEG  R7
    GET  R5, TICK
    MOV  [0], R5
walls_done:
    RET
`;

  BB.EXAMPLES = [
    { file: 'sentinel.asm', source: SENTINEL, blurb: 'Stationary sniper: leads targets, sidesteps bullets.' },
    { file: 'hunter.asm', source: HUNTER, blurb: 'Aggressive chaser: charges and fires point-blank.' },
    { file: 'dodger.asm', source: DODGER, blurb: 'Evasive skirmisher: keeps moving, dodges everything.' },
    { file: 'orbiter.asm', source: ORBITER, blurb: 'Circle-strafer: orbits its target while firing.' },
  ];
})(globalThis.BB = globalThis.BB || {});
