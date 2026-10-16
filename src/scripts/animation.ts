import * as THREE from 'three';

const ROOT_TRACK = 'Bip01_01.position';

// GoldSrc compiles walk/run with their forward travel pulled out (the QC's LX motion) and moves the
// player by it instead. The decompiled clips still carry it, so the body slides ahead and snaps back
// every loop. Remove that linear drift, as the compiler does, and return the distance one cycle covers.
export function stripRootMotion(clip: THREE.AnimationClip): number {
	const track = clip.tracks.find((t) => t.name === ROOT_TRACK);
	if (!track || track.times.length < 2) return 0;

	const { times, values } = track;
	const last = times.length - 1;
	const drift = [0, 1, 2].map((k) => values[last * 3 + k] - values[k]);
	const stride = Math.hypot(...drift);
	if (stride < 10) return 0; // smaller drifts are pose settles (jump lands 2.8 lower), not travel

	const span = times[last] - times[0];
	for (let i = 0; i <= last; i++) {
		const f = (times[i] - times[0]) / span;
		for (let k = 0; k < 3; k++) values[i * 3 + k] -= drift[k] * f;
	}
	return stride;
}

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

	// Replays a one-shot clip from its first frame. Bunnyhops land and take off within a frame or two,
	// so the jump never fades out in between and has to be restarted explicitly on each takeoff.
	restart(name: string) {
		this.action(name).reset();
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
		if (name === 'jump') {
			action.setLoop(THREE.LoopOnce, 1);
			action.clampWhenFinished = true;
		}
		action.setEffectiveWeight(0).play();
		this.actions.set(name, action);
		this.weights.set(name, 0);
		return action;
	}
}
