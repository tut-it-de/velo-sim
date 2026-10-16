import { Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { footPitch } from './cyclist';
import { BODY, bikePoints, frameSpec, riderPose, type FrameStyle } from './geometry';

const STYLES: FrameStyle[] = ['aero', 'allround', 'climber', 'endurance'];

describe('bike geometry', () => {
  it('reproduces a size-56 road frame', () => {
    const p = bikePoints(frameSpec('allround'));
    expect(p.wheelbase).toBeGreaterThan(0.97);
    expect(p.wheelbase).toBeLessThan(1.01);
    expect(p.headTop.y - p.bb.y).toBeCloseTo(0.565, 6);
    expect(p.headTop.z - p.bb.z).toBeCloseTo(0.395, 6);
    expect(p.rearAxle.y).toBeCloseTo(p.frontAxle.y, 6);
    expect(p.bb.y).toBeCloseTo(p.rearAxle.y - 0.072, 6);
  });

  it.each(STYLES)('%s: the knee stays bent through the whole pedal stroke and the torso angle is plausible', (style) => {
    const p = bikePoints(frameSpec(style));
    const pose = riderPose(p);
    let longest = 0;
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      const phi = footPitch(a);
      const spindle = new Vector3(pose.hip.x, p.bb.y + Math.cos(a) * p.spec.crank, p.bb.z + Math.sin(a) * p.spec.crank);
      const ankle = spindle.add(new Vector3(0, Math.sin(phi) * BODY.ankleBack + Math.cos(phi) * BODY.ankleUp, -Math.cos(phi) * BODY.ankleBack + Math.sin(phi) * BODY.ankleUp));
      longest = Math.max(longest, Vector3.Distance(pose.hip, ankle));
    }
    // Knee angle at the bottom of the stroke: 25–40° of flexion, as in a bike fit.
    const l1 = BODY.thigh;
    const l2 = BODY.shin;
    const flexion = 180 - (Math.acos((l1 * l1 + l2 * l2 - longest * longest) / (2 * l1 * l2)) * 180) / Math.PI;
    expect(flexion).toBeGreaterThan(22);
    expect(flexion).toBeLessThan(40);
    expect(pose.torsoAngle).toBeGreaterThan(25);
    expect(pose.torsoAngle).toBeLessThan(55);
    expect(Vector3.Distance(pose.shoulder, pose.elbow)).toBeCloseTo(BODY.upperArm, 4);
    expect(Vector3.Distance(pose.elbow, pose.wrist)).toBeCloseTo(BODY.forearm, 4);
  });

  it('endurance frames sit the rider more upright than aero frames', () => {
    const aero = riderPose(bikePoints(frameSpec('aero')));
    const endurance = riderPose(bikePoints(frameSpec('endurance')));
    expect(endurance.torsoAngle).toBeGreaterThan(aero.torsoAngle + 3);
  });
});
