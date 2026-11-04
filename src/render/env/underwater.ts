/**
 * Underwater screen tint: a full-screen quad drawn after the world and the view model that multiplies
 * the framebuffer by the water's transmittance — an absorption filter, so warm colours (the hand
 * included) turn blue-green instead of just greying. (The teal, dense fog is applied to the session's
 * single FogExp2 by GameRenderer.) OWNER: agent "env-fx".
 */
import * as THREE from 'three';

/** Fraction of red, green and blue that passes, in output (sRGB) space: the framebuffer is multiplied by it. */
const TRANSMITTANCE: readonly [number, number, number] = [0.42, 0.78, 0.8];

export class UnderwaterTint {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material = new THREE.MeshBasicMaterial({
    name: 'underwater-tint',
    transparent: true,
    // Non-premultiplied MultiplyBlending in r170: dst × src colour.
    blending: THREE.MultiplyBlending,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  constructor() {
    // The quad outputs its colour in sRGB (no tone mapping), so this multiplies by TRANSMITTANCE exactly.
    this.material.color.setRGB(TRANSMITTANCE[0], TRANSMITTANCE[1], TRANSMITTANCE[2], THREE.SRGBColorSpace);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.position.z = -0.5;
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** Multiplies what is already in the framebuffer by the transmittance. */
  render(renderer: THREE.WebGLRenderer): void {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }
}
