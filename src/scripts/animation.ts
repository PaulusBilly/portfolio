import * as THREE from 'three';

// One body half. Clip weights form a distribution that always sums to 1 and eases toward the
// requested clips, so switching mid-blend never pops. three's fadeIn/fadeOut restart from 0 or 1
// when interrupted, which jumps the pose or lets the bind pose leak through.
export class Layer {
	readonly actions = new Map<string, THREE.AnimationAction>();
	private readonly weights = new Map<string, number>();
	private targets = new Set<string>();
	private readonly mixer: THREE.AnimationMixer;
	private readonly clips: Map<string, THREE.AnimationClip>;
	private readonly bones: Set<string>;
	private readonly fade: number;

	// fade is the blend time constant in seconds: ~95% of the way there after 3 × fade.
	constructor(mixer: THREE.AnimationMixer, clips: Map<string, THREE.AnimationClip>, bones: Set<string>, fade = 0.08) {
		this.mixer = mixer;
		this.clips = clips;
		this.bones = bones;
		this.fade = fade;
	}

	set(names: string[]) {
		this.targets = new Set(names);
		for (const name of names) this.action(name);
	}

	// Plays a clip once from its first frame and holds the last one. Bunnyhops and repeated swings
	// come round before the previous play has faded out, so they restart explicitly.
	restart(name: string) {
		const action = this.action(name);
		action.setLoop(THREE.LoopOnce, 1);
		action.clampWhenFinished = true;
		action.reset();
	}

	update(dt: number) {
		const blending = [...this.weights.values()].some((w) => w > 0);
		const k = blending ? 1 - Math.exp(-dt / this.fade) : 1; // nothing to blend from on the first frame
		const share = 1 / this.targets.size;
		let sum = 0;
		for (const [name, action] of this.actions) {
			const from = this.weights.get(name)!;
			const to = this.targets.has(name) ? share : 0;
			let w = from + (to - from) * k;
			if (to === 0 && w < 1e-3) w = 0;
			this.weights.set(name, w);
			sum += w;
		}
		for (const [name, action] of this.actions) action.setEffectiveWeight(this.weights.get(name)! / sum);
	}

	private action(name: string) {
		let action = this.actions.get(name);
		if (action) return action;

		const clip = this.clips.get(name)!.clone();
		clip.tracks = clip.tracks.filter((t) => this.bones.has(t.name.split('.')[0]));
		action = this.mixer.clipAction(clip);
		action.setEffectiveWeight(0).play();
		this.actions.set(name, action);
		this.weights.set(name, 0);
		return action;
	}
}
