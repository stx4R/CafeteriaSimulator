# cafsim — Daeshin cafeteria crowd simulator

(Supplement to the Samsung HumanTech paper)  
*"군중 유체 관점에서 분석한 학교 급식실 병목부 전방 장애물의 흐름 안정화 효과 분석"*.

    node experiments/replicate.js     # M2 gate: reproduce the paper's Table 1 baseline
    node experiments/calibrate.js     # scan the force constants the paper does not state
    node experiments/sweep.js         # headway x corridor-split sweep  -> data/sweep.json
    node experiments/bimodal.js       # per-seed run at the critical headway -> data/bimodal.json
    node tools/build.mjs              # bundle the 3D app -> dist/simulator.html

## Layout

    core/navfield.js       eikonal (fast-marching) navigation field
    core/obstaclefield.js  signed distance + normals, from the blocked grid
    core/sfm.js            Helbing-Farkas-Vicsek social force model
    core/metrics.js        Q, rho95, P95, CVh, two pressure conventions
    core/benchmark.js      the paper's 6.0 m -> 1.2 m aperture scenario
    core/campus.js         traced campus, corridors, 3-10 release schedule
    core/run.js            campus run loop + cafeteria queueing model
    data/campus.json       traced geometry, metres (0.1613 m/px from the 60 m scale bar)
    data/calibration.json  force constants identified against Table 1
    view/                  Three.js front end
    dist/simulator.html    self-contained build

## Calibration

The paper fixes r, m, v0, tau, dt, W and the approach width but not the Helbing
constants or the approach length. A grid scan against Q, rho95 and CVh gives
A = 3000 N, B = 0.055 m, approach 8.0 m, reproducing the baseline to within
2.4 / 6.8 / 6.5 %. P95 is convention-dependent: the zone-averaged form gives
0.936 and the Helbing-2007 local-field form 1.818, bracketing the published 1.431.

## Geometry confidence

Exits, both corridors and the door were read directly off the annotated
satellite image and are reliable. Building outlines were traced from a
low-resolution image and are the weakest input — correct them in campus.json,
or in the published app's geometry panel, before quoting numbers.
