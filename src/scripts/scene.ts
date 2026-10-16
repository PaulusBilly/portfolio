import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Layer, stripRootMotion } from './animation';

// Everything is in GoldSrc units: the player is 72 tall, runs at 320 u/s, falls at 800 u/s².
const MODEL_URL = '/models/gordon.glb';
const ISO_PITCH = Math.atan(1 / Math.SQRT2); // true isometric, ≈35.26°
const SCROLLED_PITCH = THREE.MathUtils.degToRad(10); // the camera sinks to this as the hero scrolls away
const SCROLL_SPAN = 0.85; // fraction of the hero's height the descent takes
const VIEW_HEIGHT = 280; // world units visible top to bottom
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
const JUMP_CLIP_AIR = 0.75; // the jump clip's root is back at standing height here, then the landing squat
const JUMP_BUFFER = 0.12; // seconds an early Space press waits for the ground

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

export async function mountScene(canvas: HTMLCanvasElement) {
	// alpha: true so the page background shows through and always matches.
	const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
	renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
	setPitch(ISO_PITCH);

	// Lower the camera as the hero scrolls away, then raise it again on the way back. Ease out so the
	// first small scroll already reads. Reduced-motion users keep the isometric view.
	const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
	let lastPitch = ISO_PITCH;
	const followScroll = () => {
		const { top, height } = canvas.getBoundingClientRect();
		const progress = reducedMotion.matches ? 0 : THREE.MathUtils.clamp(-top / (height * SCROLL_SPAN), 0, 1);
		const pitch = THREE.MathUtils.lerp(ISO_PITCH, SCROLLED_PITCH, 1 - (1 - progress) ** 2);
		if (pitch !== lastPitch) setPitch((lastPitch = pitch));
	};

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
		// The model ships face and HEV-helmet head bodygroups; show the face.
		const meshIndex = gltf.parser.associations.get(mesh)?.meshes;
		if (meshIndex !== undefined && /\(Helmet\)/.test(gltf.parser.json.meshes[meshIndex].name)) mesh.visible = false;
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
	// Units one cycle of each gait clip covers: walk ≈ 56, run ≈ 190, crawl ≈ 100.
	const strides = new Map<string, number>();
	for (const [name, clip] of clips) {
		const stride = stripRootMotion(clip);
		if (stride) strides.set(name, stride);
	}
	let gaitPhase = 0;

	// The engine plays legs (gait) and torso (aim) as separate sequences:
	// bones before "Bip01 Spine" follow the gait, the rest follow the aim pose.
	const bones = skeleton!.bones;
	const spineIndex = bones.findIndex((b) => b.name.startsWith('Bip01_Spine'));
	const legs = new Layer(mixer, clips, new Set(bones.slice(0, spineIndex).map((b) => b.name)));
	const torso = new Layer(mixer, clips, new Set(bones.slice(spineIndex).map((b) => b.name)));

	// Input, only while the canvas has focus so the page keeps its keys otherwise.
	const held = new Set<string>();
	let jumpBuffer = 0;
	canvas.addEventListener('keydown', (e) => {
		const action = KEYS[e.code];
		if (!action) return;
		e.preventDefault();
		if (action === 'jump' && !e.repeat) jumpBuffer = JUMP_BUFFER; // a fresh press per jump, like HL
		held.add(action);
	});
	canvas.addEventListener('keyup', (e) => held.delete(KEYS[e.code]));
	canvas.addEventListener('blur', () => held.clear());
	// Clicking in shouldn't draw the keyboard focus ring; tabbing in still does.
	canvas.addEventListener('pointerdown', (e) => {
		e.preventDefault();
		canvas.focus({ focusVisible: false } as FocusOptions);
	});

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

		// Sequence choice mirrors CBasePlayer::SetAnimation.
		const speed = Math.hypot(vel.x, vel.z);
		let gait: string;
		if (!onGround) gait = 'jump';
		else if (ducking) gait = speed > 1 ? 'crawl' : 'crouch_idle';
		else gait = speed > RUN_THRESHOLD ? 'run' : speed > 1 ? 'walk' : 'deep_idle';
		legs.set([gait]);
		if (!onGround) torso.set(['jump']);
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
		renderer.setSize(w, h, false);

		// A ground step "away" moves sin(pitch) up the screen; leave headroom for the 72-unit body.
		// ponytail: walls use the isometric pitch only; a lower scrolled camera shows more floor, so they stay on screen
		const sin = Math.sin(ISO_PITCH);
		const margin = EDGE * (VIEW_HEIGHT / h);
		bounds.right = halfW - margin * 2;
		bounds.left = -bounds.right;
		bounds.away = (halfH - 72 * Math.cos(ISO_PITCH) - TOP_INSET * (VIEW_HEIGHT / h)) / sin;
		bounds.toward = -(halfH - margin) / sin;
	};
	new ResizeObserver(resize).observe(canvas);
	resize();

	// Only simulate and render while the hero is on screen.
	let visible = true;
	new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(canvas);
	const timer = new THREE.Timer();
	renderer.setAnimationLoop((time) => {
		timer.update(time);
		const dt = Math.min(timer.getDelta(), 0.05);
		if (!visible) return;
		followScroll();
		step(dt);
		renderer.render(scene, camera);
	});
}
