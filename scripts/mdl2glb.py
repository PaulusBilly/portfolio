#!/usr/bin/env python3
"""Convert a GoldSrc (Half-Life 1) studio model, .mdl version 10, to binary glTF.

    python3 -I scripts/mdl2glb.py <model.mdl> <out.glb> [sequence ...]
    python3 -I scripts/mdl2glb.py --self-test

Exports bodygroup 0 of every bodypart, the textures, the skeleton and the named sequences
(all of them when none are given). Two-blend sequences (the aim/shoot pitch extremes) become
<name>_blend01 and <name>_blend02. Clips stay in place, as the compiler leaves them; each
sequence's extracted travel per cycle is written to the scene extras as `strides`.

Standard library only. The .mdl is read as data; nothing in it is executed.
Layouts follow Valve's studio.h from the Half-Life SDK.
"""
import json
import math
import struct
import sys
import zlib

# Half-Life is Z-up and faces +X. glTF is Y-up and the site's scene expects +Z forward, so
# (x, y, z) -> (y, z, x): a proper rotation, applied once to the root bones and bind-pose verts.
C_QUAT = (-0.5, -0.5, -0.5, 0.5)


def to_gltf(v):
    return (v[1], v[2], v[0])


# --- maths ---------------------------------------------------------------------------------

def angle_quat(a):
    """mathlib.c AngleQuaternion: radians (roll, pitch, yaw) -> (x, y, z, w)."""
    sy, cy = math.sin(a[2] * 0.5), math.cos(a[2] * 0.5)
    sp, cp = math.sin(a[1] * 0.5), math.cos(a[1] * 0.5)
    sr, cr = math.sin(a[0] * 0.5), math.cos(a[0] * 0.5)
    return (
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
        cr * cp * cy + sr * sp * sy,
    )


def quat_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def quat_mat(q):
    x, y, z, w = q
    return (
        (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
        (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
        (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
    )


def mat_vec(m, v):
    return tuple(m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2] for r in range(3))


def mat_mul(a, b):
    return tuple(tuple(sum(a[r][k] * b[k][c] for k in range(3)) for c in range(3)) for r in range(3))


class Rigid:
    """Rotation + translation; studio bones never scale."""

    def __init__(self, rot, pos):
        self.rot, self.pos = rot, pos

    def __mul__(self, other):
        p = mat_vec(self.rot, other.pos)
        return Rigid(mat_mul(self.rot, other.rot), tuple(p[i] + self.pos[i] for i in range(3)))

    def apply(self, v):
        p = mat_vec(self.rot, v)
        return tuple(p[i] + self.pos[i] for i in range(3))

    def inverse(self):
        rt = tuple(tuple(self.rot[c][r] for c in range(3)) for r in range(3))
        p = mat_vec(rt, self.pos)
        return Rigid(rt, (-p[0], -p[1], -p[2]))

    def column_major(self):
        r, p = self.rot, self.pos
        return [r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, p[0], p[1], p[2], 1]


# --- studio model reader -------------------------------------------------------------------

class Mdl:
    def __init__(self, data):
        self.data = data
        ident, version = struct.unpack_from('<4si', data, 0)
        if ident != b'IDST' or version != 10:
            raise ValueError(f'not a GoldSrc studio model (ident {ident!r}, version {version})')
        (_flags, numbones, boneindex, _nbc, _bci, _nhb, _hbi, numseq, seqindex, _nsg, _sgi,
         numtextures, textureindex, _tdi, numskinref, _nsf, skinindex,
         numbodyparts, bodypartindex) = struct.unpack_from('<19i', data, 136)
        if numtextures == 0:
            raise ValueError('textures live in a separate <name>T.mdl; not supported yet')

        self.bones = []
        for i in range(numbones):
            o = boneindex + i * 112
            name = self.cstr(o, 32)
            parent, = struct.unpack_from('<i', data, o + 32)
            value = struct.unpack_from('<6f', data, o + 64)
            scale = struct.unpack_from('<6f', data, o + 88)
            self.bones.append({'name': name, 'parent': parent, 'value': value, 'scale': scale})

        self.sequences = []
        for i in range(numseq):
            o = seqindex + i * 176
            fps, = struct.unpack_from('<f', data, o + 32)
            numframes, = struct.unpack_from('<i', data, o + 56)
            linear = struct.unpack_from('<3f', data, o + 76)
            numblends, animindex = struct.unpack_from('<ii', data, o + 120)
            seqgroup, = struct.unpack_from('<i', data, o + 156)
            self.sequences.append({'name': self.cstr(o, 32), 'fps': fps, 'frames': numframes, 'linear': linear,
                                   'blends': numblends, 'animindex': animindex, 'seqgroup': seqgroup})

        self.textures = []
        for i in range(numtextures):
            o = textureindex + i * 80
            flags, width, height, index = struct.unpack_from('<4i', data, o + 64)
            self.textures.append({'name': self.cstr(o, 64), 'flags': flags, 'width': width, 'height': height, 'index': index})
        self.skins = struct.unpack_from(f'<{numskinref}h', data, skinindex)  # skin family 0

        self.bodyparts = []
        for i in range(numbodyparts):
            o = bodypartindex + i * 76
            nummodels, _base, modelindex = struct.unpack_from('<3i', data, o + 64)
            if nummodels:
                self.bodyparts.append({'name': self.cstr(o, 64), 'model': modelindex})  # bodygroup 0

    def cstr(self, o, n):
        return self.data[o:o + n].split(b'\0')[0].decode('latin1')

    def anim_value(self, p, frame):
        """Run-length decode one channel (studio_utils.c CalcBoneQuaternion)."""
        data, k = self.data, frame
        while True:
            valid, total = data[p], data[p + 1]
            if total == 0:
                raise ValueError('corrupt animation run')
            if total > k:
                break
            k -= total
            p += (valid + 1) * 2
        slot = k + 1 if valid > k else valid
        return struct.unpack_from('<h', data, p + slot * 2)[0]

    def pose(self, seq, blend, frame):
        """Per-bone (position, quaternion) at a frame, in parent space, Half-Life axes."""
        if seq['seqgroup'] != 0:
            raise ValueError(f"{seq['name']} lives in a separate sequence-group file; not supported")
        base = seq['animindex'] + blend * len(self.bones) * 12
        out = []
        for i, bone in enumerate(self.bones):
            a = base + i * 12
            offsets = struct.unpack_from('<6H', self.data, a)
            v = list(bone['value'])
            for j in range(6):
                if offsets[j]:
                    v[j] += self.anim_value(a + offsets[j], frame) * bone['scale'][j]
            out.append((tuple(v[:3]), angle_quat(v[3:])))
        return out

    def meshes(self, model):
        """Yields (texture index, triangles) per mesh; a corner is (vertindex, normindex, s, t)."""
        data = self.data
        nummesh, meshindex = struct.unpack_from('<ii', data, model + 72)
        for m in range(nummesh):
            _numtris, triindex, skinref = struct.unpack_from('<3i', data, meshindex + m * 20)
            tris, p = [], triindex
            while True:
                n, = struct.unpack_from('<h', data, p)
                p += 2
                if n == 0:
                    break
                corners = [struct.unpack_from('<4h', data, p + c * 8) for c in range(abs(n))]
                p += abs(n) * 8
                # Studio models wind clockwise; glTF front faces are counter-clockwise, so each
                # triangle is emitted reversed.
                for j in range(2, len(corners)):
                    if n < 0:  # fan
                        tris.append((corners[j], corners[j - 1], corners[0]))
                    elif j % 2 == 0:  # strip, alternating winding
                        tris.append((corners[j], corners[j - 1], corners[j - 2]))
                    else:
                        tris.append((corners[j], corners[j - 2], corners[j - 1]))
            yield self.skins[skinref], tris

    def model_arrays(self, model):
        data = self.data
        numverts, vertinfoindex, vertindex, numnorms, norminfoindex, normindex = struct.unpack_from('<6i', data, model + 80)
        verts = [struct.unpack_from('<3f', data, vertindex + i * 12) for i in range(numverts)]
        norms = [struct.unpack_from('<3f', data, normindex + i * 12) for i in range(numnorms)]
        return verts, data[vertinfoindex:vertinfoindex + numverts], norms, data[norminfoindex:norminfoindex + numnorms]

    def texture_rgba(self, tex):
        w, h, o = tex['width'], tex['height'], tex['index']
        pixels = self.data[o:o + w * h]
        palette = self.data[o + w * h:o + w * h + 768]
        masked = bool(tex['flags'] & 0x40)  # STUDIO_NF_MASKED: palette index 255 is transparent
        out = bytearray()
        for i in pixels:
            out += palette[i * 3:i * 3 + 3] + (b'\0' if masked and i == 255 else b'\xff')
        return bytes(out), masked


# --- glTF writer ---------------------------------------------------------------------------

def png(w, h, rgba):
    raw = b''.join(b'\0' + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))

    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


class Gltf:
    FLOAT, USHORT = 5126, 5123

    def __init__(self):
        self.json = {'asset': {'version': '2.0', 'generator': 'mdl2glb.py'}, 'buffers': [], 'bufferViews': [], 'accessors': []}
        self.bin = bytearray()

    def view(self, blob, target=None):
        while len(self.bin) % 4:
            self.bin += b'\0'
        view = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(blob)}
        if target:
            view['target'] = target
        self.bin += blob
        self.json['bufferViews'].append(view)
        return len(self.json['bufferViews']) - 1

    def accessor(self, values, kind, width, component=FLOAT, target=None, bounds=False):
        fmt = 'f' if component == self.FLOAT else 'H'
        flat = [x for v in values for x in (v if isinstance(v, (tuple, list)) else (v,))]
        acc = {'bufferView': self.view(struct.pack(f'<{len(flat)}{fmt}', *flat), target),
               'componentType': component, 'count': len(values), 'type': kind}
        if bounds:
            cols = [flat[i::width] for i in range(width)]
            acc['min'] = [min(c) for c in cols]
            acc['max'] = [max(c) for c in cols]
        self.json['accessors'].append(acc)
        return len(self.json['accessors']) - 1

    def glb(self):
        self.json['buffers'] = [{'byteLength': len(self.bin)}]
        body = json.dumps(self.json, separators=(',', ':')).encode()
        body += b' ' * (-len(body) % 4)
        binary = bytes(self.bin) + b'\0' * (-len(self.bin) % 4)
        total = 12 + 8 + len(body) + 8 + len(binary)
        return (struct.pack('<4sII', b'glTF', 2, total) + struct.pack('<I4s', len(body), b'JSON') + body
                + struct.pack('<I4s', len(binary), b'BIN\0') + binary)


def convert(mdl, wanted):
    g = Gltf()
    j = g.json
    bones = mdl.bones

    # Skeleton in the bind pose (the bones' default values), converted at the roots.
    local, world = [], []
    for i, bone in enumerate(bones):
        pos, rot = tuple(bone['value'][:3]), angle_quat(bone['value'][3:])
        if bone['parent'] < 0:
            pos, rot = to_gltf(pos), quat_mul(C_QUAT, rot)
        local.append((pos, rot))
        here = Rigid(quat_mat(rot), pos)
        world.append(world[bone['parent']] * here if bone['parent'] >= 0 else here)

    j['nodes'] = [{'name': b['name'], 'translation': list(local[i][0]), 'rotation': list(local[i][1])} for i, b in enumerate(bones)]
    for i, bone in enumerate(bones):
        if bone['parent'] >= 0:
            j['nodes'][bone['parent']].setdefault('children', []).append(i)
    roots = [i for i, b in enumerate(bones) if b['parent'] < 0]
    j['skins'] = [{'joints': list(range(len(bones))), 'skeleton': roots[0],
                   'inverseBindMatrices': g.accessor([w.inverse().column_major() for w in world], 'MAT4', 16)}]

    # Textures and materials, one per studio texture.
    j['images'], j['textures'], j['materials'] = [], [], []
    j['samplers'] = [{'magFilter': 9728, 'minFilter': 9986, 'wrapS': 10497, 'wrapT': 10497}]  # point-sampled
    for tex in mdl.textures:
        rgba, masked = mdl.texture_rgba(tex)
        j['images'].append({'name': tex['name'], 'mimeType': 'image/png',
                            'bufferView': g.view(png(tex['width'], tex['height'], rgba))})
        j['textures'].append({'source': len(j['images']) - 1, 'sampler': 0})
        material = {'name': tex['name'], 'pbrMetallicRoughness': {
            'baseColorTexture': {'index': len(j['textures']) - 1}, 'metallicFactor': 0, 'roughnessFactor': 1}}
        if masked:
            material['alphaMode'] = 'MASK'
        j['materials'].append(material)

    # One mesh per bodypart, one primitive per studio mesh; every vertex follows exactly one bone.
    j['meshes'] = []
    mesh_nodes = []
    for part in mdl.bodyparts:
        verts, vbone, norms, nbone = mdl.model_arrays(part['model'])
        primitives = []
        for texture, tris in mdl.meshes(part['model']):
            tex = mdl.textures[texture]
            index_of, pos, nrm, uv, joint, order = {}, [], [], [], [], []
            for tri in tris:
                for corner in tri:
                    if corner not in index_of:
                        vi, ni, s, t = corner
                        b = vbone[vi]
                        index_of[corner] = len(pos)
                        # Stored in bone space; world[] already carries the Z-up -> Y-up change.
                        pos.append(world[b].apply(verts[vi]))
                        nrm.append(normalize(mat_vec(world[nbone[ni]].rot, norms[ni])))
                        uv.append((s / tex['width'], t / tex['height']))
                        joint.append((b, 0, 0, 0))
                    order.append(index_of[corner])
            primitives.append({
                'attributes': {
                    'POSITION': g.accessor(pos, 'VEC3', 3, target=34962, bounds=True),
                    'NORMAL': g.accessor(nrm, 'VEC3', 3, target=34962),
                    'TEXCOORD_0': g.accessor(uv, 'VEC2', 2, target=34962),
                    'JOINTS_0': g.accessor(joint, 'VEC4', 4, component=Gltf.USHORT, target=34962),
                    'WEIGHTS_0': g.accessor([(1.0, 0.0, 0.0, 0.0)] * len(pos), 'VEC4', 4, target=34962),
                },
                'indices': g.accessor(order, 'SCALAR', 1, component=Gltf.USHORT, target=34963),
                'material': texture,
            })
        j['meshes'].append({'name': part['name'], 'primitives': primitives})
        j['nodes'].append({'name': part['name'], 'mesh': len(j['meshes']) - 1, 'skin': 0})
        mesh_nodes.append(len(j['nodes']) - 1)

    # Animations: every frame of every bone, constant channels collapsed to one key.
    j['animations'] = []
    strides = {}
    names = {s['name'] for s in mdl.sequences}
    missing = [w for w in wanted if w not in names]
    if missing:
        raise ValueError(f'no such sequences: {", ".join(missing)}')
    for seq in mdl.sequences:
        if wanted and seq['name'] not in wanted:
            continue
        stride = math.hypot(*seq['linear'])
        if stride:
            strides[seq['name']] = round(stride, 3)
        times = [f / seq['fps'] for f in range(seq['frames'])]
        for blend in range(seq['blends']):
            frames = [mdl.pose(seq, blend, f) for f in range(seq['frames'])]
            channels, samplers = [], []
            for i, bone in enumerate(bones):
                root = bone['parent'] < 0
                tracks = {
                    'translation': [to_gltf(fr[i][0]) if root else fr[i][0] for fr in frames],
                    'rotation': continuous([quat_mul(C_QUAT, fr[i][1]) if root else fr[i][1] for fr in frames]),
                }
                for path, values in tracks.items():
                    constant = all(max(abs(a - b) for a, b in zip(v, values[0])) < 1e-6 for v in values)
                    keys = values[:1] if constant else values
                    samplers.append({
                        'input': g.accessor(times[:len(keys)], 'SCALAR', 1, bounds=True),
                        'output': g.accessor(keys, 'VEC4' if path == 'rotation' else 'VEC3', 4 if path == 'rotation' else 3),
                        'interpolation': 'LINEAR',
                    })
                    channels.append({'sampler': len(samplers) - 1, 'target': {'node': i, 'path': path}})
            name = seq['name'] if seq['blends'] == 1 else f"{seq['name']}_blend{blend + 1:02d}"
            j['animations'].append({'name': name, 'channels': channels, 'samplers': samplers})

    j['scenes'] = [{'nodes': roots + mesh_nodes, 'extras': {'strides': strides}}]
    j['scene'] = 0
    return g.glb()


def normalize(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return tuple(x / n for x in v)


def continuous(quats):
    """Keep consecutive keys in the same hemisphere so linear blending never takes the long way."""
    out = [quats[0]]
    for q in quats[1:]:
        if sum(a * b for a, b in zip(q, out[-1])) < 0:
            q = tuple(-x for x in q)
        out.append(q)
    return out


def self_test():
    close = lambda a, b: all(abs(x - y) < 1e-9 for x, y in zip(a, b))
    # A quarter turn of yaw takes +X to +Y.
    assert close(mat_vec(quat_mat(angle_quat((0, 0, math.pi / 2))), (1, 0, 0)), (0, 1, 0))
    # The axis change sends Half-Life forward (+X) to +Z and up (+Z) to +Y, and C_QUAT agrees.
    assert to_gltf((1, 0, 0)) == (0, 0, 1) and to_gltf((0, 0, 1)) == (0, 1, 0)
    for v in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
        assert close(mat_vec(quat_mat(C_QUAT), v), to_gltf(v))
    # Run-length channel: valid=2, total=4 holds [5, 7] then repeats 7; a second run holds [-3].
    blob = struct.pack('<BBhh', 2, 4, 5, 7) + struct.pack('<BBh', 1, 1, -3)
    m = object.__new__(Mdl)
    m.data = blob
    assert [m.anim_value(0, f) for f in range(5)] == [5, 7, 7, 7, -3]
    # Rigid inverse undoes the transform.
    r = Rigid(quat_mat(angle_quat((0.3, -0.2, 1.1))), (4, -2, 9))
    assert close((r.inverse() * r).apply((1, 2, 3)), (1, 2, 3))
    # PNG framing: signature, IHDR and a valid IEND CRC.
    p = png(1, 1, b'\x01\x02\x03\xff')
    assert p.startswith(b'\x89PNG\r\n\x1a\n') and p.endswith(b'IEND\xaeB`\x82')
    print('self-test ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        self_test()
        sys.exit()
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    with open(sys.argv[1], 'rb') as f:
        model = Mdl(f.read())
    out = convert(model, set(sys.argv[3:]))
    with open(sys.argv[2], 'wb') as f:
        f.write(out)
    print(f'{sys.argv[2]}: {len(out) / 1024:.0f} KB, {len(model.bones)} bones, {len(model.textures)} textures')
