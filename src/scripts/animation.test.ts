import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { stripRootMotion, Layer } from './animation.ts';

test('stripRootMotion removes the forward drift, keeps the bob, and reports the stride', () => {
	// Like the decompiled walk: root slides 56 units down local Y over the cycle, bobbing on Z.
	const times = [0, 0.25, 0.5, 0.75, 1];
	const values = times.flatMap((t) => [0.24, -56 * t, 2.8 + Math.sin(t * Math.PI * 2)]);
	const clip = new THREE.AnimationClip('walk', 1, [new THREE.VectorKeyframeTrack('Bip01_01.position', times, values)]);

	assert.equal(Math.round(stripRootMotion(clip)), 56);
	const v = clip.tracks[0].values;
	for (let i = 0; i < times.length; i++) assert.ok(Math.abs(v[i * 3 + 1]) < 1e-6, 'no forward travel left');
	assert.ok(Math.abs(v[1 * 3 + 2] - 3.8) < 1e-6, 'bob untouched');
});

test('stripRootMotion leaves small settles alone', () => {
	const clip = new THREE.AnimationClip('jump', 1, [
		new THREE.VectorKeyframeTrack('Bip01_01.position', [0, 1], [0, 0, 2.8, 0, 0, 0]),
	]);
	assert.equal(stripRootMotion(clip), 0);
	assert.equal(clip.tracks[0].values[5], 0);
});

test('Layer weights always sum to 1 and never jump, even when switching mid-fade', () => {
	const root = new THREE.Object3D();
	const bone = new THREE.Object3D();
	bone.name = 'b';
	root.add(bone);
	const clip = (name: string) =>
		new THREE.AnimationClip(name, 1, [new THREE.VectorKeyframeTrack('b.position', [0, 1], [0, 0, 0, 1, 1, 1])]);
	const clips = new Map(['a', 'b', 'c', 'd'].map((n) => [n, clip(n)]));
	const mixer = new THREE.AnimationMixer(root);
	const layer = new Layer(mixer, clips, new Set(['b']), 0.08);

	const dt = 1 / 60;
	const plan = ['a', 'a', 'a', 'b', 'b', 'c', 'a', 'a', 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b', ...Array(40).fill('b')];
	let prev = new Map<string, number>();
	for (const name of plan) {
		layer.set(name === 'c' ? ['c', 'd'] : [name]);
		layer.update(dt);
		const weights = new Map([...layer.actions].map(([n, a]) => [n, a.getEffectiveWeight()]));
		const sum = [...weights.values()].reduce((s, w) => s + w, 0);
		assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
		for (const [n, w] of weights) {
			if (prev.size) assert.ok(Math.abs(w - (prev.get(n) ?? 0)) < 0.25, `${n} jumped ${prev.get(n)} → ${w}`);
		}
		prev = weights;
	}
	assert.ok(layer.actions.get('b')!.getEffectiveWeight() > 0.999, 'settles on the last request');
});

test('Layer.restart replays a one-shot clip even while it still has weight', () => {
	const root = new THREE.Object3D();
	const bone = new THREE.Object3D();
	bone.name = 'b';
	root.add(bone);
	const clips = new Map([
		['jump', new THREE.AnimationClip('jump', 1, [new THREE.VectorKeyframeTrack('b.position', [0, 1], [0, 0, 0, 1, 1, 1])])],
		['run', new THREE.AnimationClip('run', 1, [new THREE.VectorKeyframeTrack('b.position', [0, 1], [0, 0, 0, 1, 1, 1])])],
	]);
	const mixer = new THREE.AnimationMixer(root);
	const layer = new Layer(mixer, clips, new Set(['b']));
	const tick = (dt: number) => { layer.update(dt); mixer.update(dt); };

	layer.set(['jump']);
	layer.restart('jump');
	for (let i = 0; i < 40; i++) tick(1 / 60); // airborne ~0.67 s
	layer.set(['run']);
	tick(1 / 60); // one frame on the ground: jump still carries most of the weight
	assert.ok(layer.actions.get('jump')!.getEffectiveWeight() > 0.5);

	layer.set(['jump']);
	layer.restart('jump'); // bunnyhop: take off again
	tick(1 / 60);
	assert.ok(layer.actions.get('jump')!.time < 0.05, `second hop starts at the top, not at ${layer.actions.get('jump')!.time}`);
});
