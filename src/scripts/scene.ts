import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Layer } from './animation';

// Everything is in GoldSrc units: the player is 72 tall, runs at 320 u/s, falls at 800 u/s².
// Built from the player .mdl by scripts/mdl2glb.py.
const MODEL_URL = '/models/gordon-sci.glb';
// Scroll feel follows shujaat.info: a low view that sinks to 2° as the hero scrolls away. He starts at 16°;
// 26° keeps walking away from the camera from looking slow (sin 26° ≈ 0.44 of a step shows on screen).
const PITCH = THREE.MathUtils.degToRad(26);
const SCROLLED_PITCH = THREE.MathUtils.degToRad(2);
const SCROLL_SPAN = 0.85; // fraction of the hero's height the descent takes
const PITCH_DAMPING = 10; // how fast the camera chases the scroll target (THREE.MathUtils.damp lambda)
const RENDER_ROWS = 720; // drawing-buffer height, whatever the screen
const VIEW_HEIGHT = 290; // world units visible top to bottom
const EDGE = 24; // keep the player this far inside the canvas edges
const TOP_INSET = 64; // the site header floats over the top of the canvas

// Stock Half-Life server cvars (sv_*) and client speeds (cl_*).
const SV = {
	maxspeed: 320,
	accelerate: 10,
	airaccelerate: 10,
	friction: 4,
	stopspeed: 100,
	gravity: 800,
	jumpSpeed: Math.sqrt(2 * 800 * 45), // pm_shared.c: jump to 45 units
};
const CL_MOVESPEED = 400;
const WALK_SCALE = 0.3; // cl_movespeedkey, the +speed (shift) key
const DUCK_SCALE = 0.333;
const RUN_THRESHOLD = 220; // player.cpp picks the run gait above this speed
const AIRTIME = (2 * SV.jumpSpeed) / SV.gravity; // ≈0.67 s on flat ground
const JUMP_CLIP_AIR = 0.585; // the jump clip's root is back at standing height here, then the landing squat
const JUMP_BUFFER = 0.12; // seconds an early Space press waits for the ground
const SWING_DELAY = 0.5; // crowbar.cpp: next attack 0.5 s after a miss (0.25 s after a hit; nothing to hit here)
const SWING = ['ref_shoot_crowbar_blend01', 'ref_shoot_crowbar_blend02'];
const CROUCH_SWING = ['crouch_shoot_crowbar_blend01', 'crouch_shoot_crowbar_blend02'];

const TURN_RATE = 14; // how quickly the body swings round to the input direction, per second

// Ground axes as seen on screen: W moves up the screen, D moves right.
const RIGHT = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
const AWAY = new THREE.Vector3(-Math.SQRT1_2, 0, -Math.SQRT1_2);

const KEYS: Record<string, string> = {
	KeyW: 'forward', ArrowUp: 'forward',
	KeyS: 'back', ArrowDown: 'back',
	KeyA: 'left', ArrowLeft: 'left',
	KeyD: 'right', ArrowRight: 'right',
	ShiftLeft: 'walk', ShiftRight: 'walk',
	KeyC: 'duck',
	Space: 'jump',
};

// `canvas` fills the hero; `stage` is the hero box over it, which takes the input and focus and whose
// scroll drives the camera.
export async function mountScene(canvas: HTMLCanvasElement, stage: HTMLElement) {
	// alpha: true so the page background shows through and always matches.
	// Low-res and aliased on purpose, like shujaat.info: a fixed number of rows scaled up with
	// image-rendering: pixelated reads as a game render, and costs a fraction of a native-res canvas.
	const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFShadowMap;

	const scene = new THREE.Scene();
	const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
	const distance = 1500;
	const setPitch = (pitch: number) => {
		camera.position.set(
			distance * Math.cos(pitch) * Math.SQRT1_2,
			distance * Math.sin(pitch),
			distance * Math.cos(pitch) * Math.SQRT1_2,
		);
		camera.lookAt(0, 0, 0);
	};
	setPitch(PITCH);

	// Lower the camera as the hero scrolls away, then raise it again on the way back. Ease out so the
	// first small scroll already reads, and damp toward it so the camera glides rather than snaps to
	// each scroll step. Reduced-motion users keep the starting view.
	const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
	let pitch = PITCH;
	const followScroll = (dt: number) => {
		const { top, height } = stage.getBoundingClientRect();
		const finishAt = scrollY + top + height * SCROLL_SPAN;
		const progress = reducedMotion.matches ? 0 : THREE.MathUtils.clamp(scrollY / Math.max(1, finishAt), 0, 1);
		const target = THREE.MathUtils.lerp(PITCH, SCROLLED_PITCH, 1 - (1 - progress) ** 2);
		if (Math.abs(target - pitch) < 1e-5) return;
		pitch = THREE.MathUtils.damp(pitch, target, PITCH_DAMPING, dt);
		setPitch(pitch);
		document.body.style.setProperty('--land-lift', `${landLift(pitch)}px`);
	};

	// The page background is the top of the land, and the content block below the hero is its cut face
	// (see .underland on the home page). The land's near edge is placed so that at the starting pitch it
	// projects exactly onto the hero's bottom edge, where that block begins. Lowering the camera raises
	// the edge by this many pixels; the block is lifted by the same amount, so the face, its text and
	// Gordon's ground stay one surface. Being DOM, the face scrolls natively with the text.
	const landLift = (p: number) => (VIEW_HEIGHT / 2) * (Math.sin(p) / Math.sin(PITCH) - 1) * (canvas.clientHeight / VIEW_HEIGHT);

	scene.add(new THREE.HemisphereLight(0xffffff, 0xb0b0b0, 3));
	const sun = new THREE.DirectionalLight(0xffffff, 1.4);
	sun.position.set(150, 500, 250);
	sun.castShadow = true;
	sun.shadow.mapSize.set(2048, 2048);
	sun.shadow.radius = 4;
	Object.assign(sun.shadow.camera, { left: -500, right: 500, top: 500, bottom: -500, near: 1, far: 1500 });
	scene.add(sun);

	// Invisible floor that only receives the shadow.
	const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.ShadowMaterial({ opacity: 0.12 }));
	floor.rotation.x = -Math.PI / 2;
	floor.receiveShadow = true;
	scene.add(floor);

	const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
	const model = gltf.scene;
	let skeleton: THREE.Skeleton | undefined;
	model.traverse((obj) => {
		if (!(obj as THREE.Mesh).isMesh) return;
		const mesh = obj as THREE.SkinnedMesh;
		mesh.castShadow = true;
		mesh.frustumCulled = false; // skinned bounds don't follow the animation
		skeleton ??= mesh.skeleton;

		// GoldSrc models are matte and point-sampled: Lambert shading, no filtering blur.
		const old = mesh.material as THREE.MeshStandardMaterial;
		if (old.map) {
			old.map.magFilter = THREE.NearestFilter;
			old.map.minFilter = THREE.NearestMipmapLinearFilter;
		}
		mesh.material = new THREE.MeshLambertMaterial({ map: old.map, side: old.side });
		old.dispose();
	});
	scene.add(model);

	const mixer = new THREE.AnimationMixer(model);
	const clips = new Map(gltf.animations.map((clip) => {
		if (clip.duration === 0) clip.duration = 1 / 30; // single-frame poses
		return [clip.name, clip];
	}));
	// Units one cycle of each gait clip covers (the sequences' linear movement): walk 54, run 182, crawl 97.
	const strides = new Map<string, number>(Object.entries(model.userData.strides ?? {}));
	let gaitPhase = 0;

	// The engine plays legs (gait) and torso (aim) as separate sequences:
	// bones before "Bip01 Spine" follow the gait, the rest follow the aim pose.
	const bones = skeleton!.bones;
	const spineIndex = bones.findIndex((b) => b.name.startsWith('Bip01_Spine'));
	const legs = new Layer(mixer, clips, new Set(bones.slice(0, spineIndex).map((b) => b.name)));
	const torso = new Layer(mixer, clips, new Set(bones.slice(spineIndex).map((b) => b.name)));

	// Input, only while the stage has focus so the page keeps its keys otherwise.
	const held = new Set<string>();
	let jumpBuffer = 0;
	stage.addEventListener('keydown', (e) => {
		const action = KEYS[e.code];
		if (!action) return;
		e.preventDefault();
		if (action === 'jump' && !e.repeat) jumpBuffer = JUMP_BUFFER; // a fresh press per jump, like HL
		held.add(action);
	});
	stage.addEventListener('keyup', (e) => held.delete(KEYS[e.code]));
	stage.addEventListener('blur', () => held.clear());
	// Mouse 1 swings, held down it keeps swinging. Clicking in shouldn't draw the keyboard focus
	// ring; tabbing in still does.
	let attacking = false;
	stage.addEventListener('pointerdown', (e) => {
		e.preventDefault();
		stage.focus({ focusVisible: false } as FocusOptions);
		if (e.button !== 0) return;
		stage.setPointerCapture(e.pointerId);
		attacking = true;
	});
	for (const type of ['pointerup', 'pointercancel', 'blur'] as const) stage.addEventListener(type, () => (attacking = false));
	let nextSwing = 0;
	let swing: string[] = [];
	let swingLeft = 0;

	// Movement state, ported from pm_shared.c.
	const pos = new THREE.Vector3();
	const vel = new THREE.Vector3();
	let onGround = true;
	let yaw = Math.PI / 4; // start facing the camera
	const wishdir = new THREE.Vector3();
	const bounds = { right: 0, left: 0, away: 0, toward: 0 };

	const friction = (dt: number) => {
		const speed = Math.hypot(vel.x, vel.z);
		if (speed < 0.1) return;
		const control = Math.max(speed, SV.stopspeed);
		const scale = Math.max(speed - control * SV.friction * dt, 0) / speed;
		vel.x *= scale;
		vel.z *= scale;
	};

	const accelerate = (wishspeed: number, accel: number, dt: number, cap = wishspeed) => {
		const add = Math.min(wishspeed, cap) - vel.dot(wishdir);
		if (add <= 0) return;
		vel.addScaledVector(wishdir, Math.min(accel * wishspeed * dt, add));
	};

	const step = (dt: number) => {
		const ducking = held.has('duck');
		const fmove = (+held.has('forward') - +held.has('back')) * CL_MOVESPEED;
		const smove = (+held.has('right') - +held.has('left')) * CL_MOVESPEED;
		const scale = (held.has('walk') ? WALK_SCALE : 1) * (ducking ? DUCK_SCALE : 1);
		wishdir.copy(AWAY).multiplyScalar(fmove * scale).addScaledVector(RIGHT, smove * scale);
		const wishspeed = Math.min(wishdir.length(), SV.maxspeed);
		wishdir.normalize();

		// HL drops a press made in the air; buffering it briefly keeps spammed bunnyhops from turning into runs.
		jumpBuffer -= dt;
		if (jumpBuffer > 0 && onGround) {
			vel.y = SV.jumpSpeed;
			onGround = false; // skips this frame's friction, which is what makes bunnyhopping work
			jumpBuffer = 0;
			for (const layer of [legs, torso]) {
				layer.restart('jump');
				// Stretch the jump so its touchdown frame meets the ground when the physics does.
				layer.actions.get('jump')!.timeScale = JUMP_CLIP_AIR / AIRTIME;
			}
		}

		if (onGround) {
			friction(dt);
			accelerate(wishspeed, SV.accelerate, dt);
		} else {
			accelerate(wishspeed, SV.airaccelerate, dt, 30); // air control caps at 30 u/s
			vel.y -= SV.gravity * dt;
		}

		pos.addScaledVector(vel, dt);
		if (pos.y <= 0 && !onGround) {
			pos.y = 0;
			vel.y = 0;
			onGround = true;
		}

		// Canvas edges act as walls: clamp in screen-aligned ground axes and kill the blocked velocity.
		const a = pos.dot(RIGHT);
		const b = pos.dot(AWAY);
		const ca = THREE.MathUtils.clamp(a, bounds.left, bounds.right);
		const cb = THREE.MathUtils.clamp(b, bounds.toward, bounds.away);
		if (ca !== a) vel.addScaledVector(RIGHT, -vel.dot(RIGHT));
		if (cb !== b) vel.addScaledVector(AWAY, -vel.dot(AWAY));
		pos.set(0, pos.y, 0).addScaledVector(RIGHT, ca).addScaledVector(AWAY, cb);

		// Face where the player is steering, like the engine's view-driven body yaw. Following velocity
		// instead whips round on reversals and jitters as friction brings it to rest.
		if (wishspeed > 0) {
			const target = Math.atan2(wishdir.x, wishdir.z); // this export looks down +Z at yaw 0
			const delta = Math.atan2(Math.sin(target - yaw), Math.cos(target - yaw));
			yaw += delta * (1 - Math.exp(-dt * TURN_RATE));
		}
		// pos is the floor point; the model's origin is the hull centre, 36 up standing and 18 ducked.
		model.position.set(pos.x, pos.y + (ducking ? 18 : 36), pos.z);
		model.rotation.y = yaw;

		// A swing takes over the torso until it finishes; the legs keep their gait underneath.
		nextSwing -= dt;
		swingLeft -= dt;
		if (attacking && nextSwing <= 0) {
			nextSwing = SWING_DELAY;
			swing = ducking ? CROUCH_SWING : SWING;
			for (const name of swing) torso.restart(name);
			swingLeft = clips.get(swing[0])!.duration;
		}

		// Sequence choice mirrors CBasePlayer::SetAnimation.
		const speed = Math.hypot(vel.x, vel.z);
		let gait: string;
		if (!onGround) gait = 'jump';
		else if (ducking) gait = speed > 1 ? 'crawl' : 'crouch_idle';
		else gait = speed > RUN_THRESHOLD ? 'run' : speed > 1 ? 'walk' : 'deep_idle';
		legs.set([gait]);
		if (swingLeft > 0) torso.set(swing);
		else if (!onGround) torso.set(['jump']);
		else if (ducking) torso.set(['crouch_aim_crowbar_blend01', 'crouch_aim_crowbar_blend02']);
		else torso.set(['ref_aim_crowbar_blend01', 'ref_aim_crowbar_blend02']); // two pitch extremes → level aim

		// Gait clips advance by distance covered, not time (StudioProcessGait), so the feet stay planted
		// at any speed; they share one phase so walk ↔ run swaps keep the stride.
		const stride = strides.get(gait);
		if (stride) gaitPhase = (gaitPhase + (speed * dt) / stride) % 1;
		for (const [name, action] of legs.actions) {
			if (!strides.has(name)) continue;
			action.timeScale = 0;
			action.time = gaitPhase * action.getClip().duration;
		}
		legs.update(dt);
		torso.update(dt);
		mixer.update(dt);
	};

	const resize = () => {
		const { clientWidth: w, clientHeight: h } = canvas;
		const halfW = (VIEW_HEIGHT * (w / h)) / 2;
		const halfH = VIEW_HEIGHT / 2;
		Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
		camera.updateProjectionMatrix();
		document.body.style.setProperty('--land-lift', `${landLift(pitch)}px`);
		renderer.setPixelRatio(Math.min(devicePixelRatio, RENDER_ROWS / h));
		renderer.setSize(w, h, false);

		// A ground step "away" moves sin(pitch) up the screen; leave headroom for the 72-unit body.
		// ponytail: walls use the starting pitch only; a lower scrolled camera shows more floor, so they stay on screen
		const sin = Math.sin(PITCH);
		const margin = EDGE * (VIEW_HEIGHT / h);
		bounds.right = halfW - margin * 2;
		bounds.left = -bounds.right;
		bounds.away = (halfH - 72 * Math.cos(PITCH) - TOP_INSET * (VIEW_HEIGHT / h)) / sin;
		bounds.toward = -(halfH - margin) / sin;
	};
	new ResizeObserver(resize).observe(canvas);
	resize();

	// The camera (and the face's lift) follows scroll every display frame, so the edge moves as smoothly
	// as the page. Simulating and drawing are capped at 60 fps and only run while the hero is on screen.
	let visible = true;
	new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(stage);
	const timer = new THREE.Timer();
	let lastTick = NaN;
	let lastFrame = -Infinity;
	renderer.setAnimationLoop((time) => {
		followScroll(Number.isNaN(lastTick) ? 0 : Math.min((time - lastTick) / 1000, 0.05));
		lastTick = time;
		if (!visible || time - lastFrame < 1000 / 60 - 2) return;
		lastFrame = time;
		timer.update(time);
		step(Math.min(timer.getDelta(), 0.05));
		renderer.render(scene, camera);
	});
}
