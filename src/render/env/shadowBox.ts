/**
 * Placement of the sun/moon shadow box. OWNER: agent "env-fx".
 *
 * The orthographic shadow camera of a DirectionalLight sits at the light's position and looks at its
 * target with up = +Y. Keeping the box centred on the player while snapping its light-space x/y to
 * whole shadow-map texels makes the texel grid stay put in the world as the player moves, so shadow
 * edges do not crawl or shimmer.
 */
import * as THREE from 'three';
import type { Vec3Like } from '../../core/math';

const right = new THREE.Vector3();
const up = new THREE.Vector3();

/**
 * Writes the light target (`outTarget`) and light position (`outLight`) for a shadow box centred on
 * `focus` (snapped to `texel`-sized steps across the light direction), with the light `distance`
 * units from the target along `lightDir` (unit vector towards the light).
 */
export function placeShadowBox(
  focus: Vec3Like,
  lightDir: THREE.Vector3,
  texel: number,
  distance: number,
  outTarget: THREE.Vector3,
  outLight: THREE.Vector3,
): void {
  // Same basis as Matrix4.lookAt for a camera at the light looking at the target: x = up × z, y = z × x.
  right.set(lightDir.z, 0, -lightDir.x);
  if (right.lengthSq() < 1e-10) right.set(1, 0, 0);
  right.normalize();
  up.crossVectors(lightDir, right);
  const fx = focus.x * right.x + focus.y * right.y + focus.z * right.z;
  const fy = focus.x * up.x + focus.y * up.y + focus.z * up.z;
  const fz = focus.x * lightDir.x + focus.y * lightDir.y + focus.z * lightDir.z;
  const sx = Math.round(fx / texel) * texel;
  const sy = Math.round(fy / texel) * texel;
  outTarget.copy(right).multiplyScalar(sx).addScaledVector(up, sy).addScaledVector(lightDir, fz);
  outLight.copy(outTarget).addScaledVector(lightDir, distance);
}
