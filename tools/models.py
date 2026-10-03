#!/usr/bin/env python3
"""Turn the Collada logos into the small mesh files scene.js draws.

Usage: tools/models.py collada/deFEEST.dae models/defeest.bin
                       collada/bawl-e.dae   models/bawl-e.bin

Each .bin is: uint32 part count, then per part: float32 r, g, b, uint32 vertex count, and
that many vertices of 12 bytes: int16 x, y, z, 0 (position * 32767) and int8 nx, ny, nz, 0
(normal * 127). Triangles, node transforms applied, Y up, centred, scaled to a radius of 1.
Flat colours only: neither model has a texture.
"""
import struct
import sys
import xml.etree.ElementTree as ET

import numpy as np

NS = {'c': 'http://www.collada.org/2005/11/COLLADASchema'}


def floats(text):
    return np.array(text.split(), dtype=np.float64)


def load(path):
    root = ET.parse(path).getroot()
    up = root.find('.//c:up_axis', NS)
    z_up = up is not None and up.text == 'Z_UP'
    colours = {}
    for effect in root.findall('.//c:library_effects/c:effect', NS):
        diffuse = effect.find('.//c:diffuse/c:color', NS)
        colours[effect.get('id')] = floats(diffuse.text)[:3] if diffuse is not None else np.ones(3)
    materials = {m.get('id'): colours.get(m.find('c:instance_effect', NS).get('url')[1:], np.ones(3))
                 for m in root.findall('.//c:library_materials/c:material', NS)}
    geometries = {g.get('id'): g for g in root.findall('.//c:library_geometries/c:geometry', NS)}

    parts = {}                                     # colour -> list of (positions, normals)

    def mesh(geometry, matrix, binds):
        m = geometry.find('c:mesh', NS)
        sources = {s.get('id'): floats(s.find('c:float_array', NS).text).reshape(-1, int(s.find('.//c:accessor', NS).get('stride')))
                   for s in m.findall('c:source', NS)}
        vertices = {v.get('id'): v.find("c:input[@semantic='POSITION']", NS).get('source')[1:] for v in m.findall('c:vertices', NS)}
        for prim in m:
            kind = prim.tag.split('}')[1]
            if kind not in ('triangles', 'polylist'):
                continue
            inputs = prim.findall('c:input', NS)
            stride = max(int(i.get('offset')) for i in inputs) + 1
            idx = np.array(prim.find('c:p', NS).text.split(), dtype=np.int64).reshape(-1, stride)
            pos_off = nrm_off = None
            for i in inputs:
                if i.get('semantic') == 'VERTEX':
                    pos_off, pos_src = int(i.get('offset')), vertices[i.get('source')[1:]]
                elif i.get('semantic') == 'NORMAL':
                    nrm_off, nrm_src = int(i.get('offset')), i.get('source')[1:]
            counts = (np.array(prim.find('c:vcount', NS).text.split(), dtype=np.int64)
                      if kind == 'polylist' else np.full(len(idx) // 3, 3))
            tris, start = [], 0
            for n in counts:                       # fan-triangulate each polygon
                for k in range(1, n - 1):
                    tris += [start, start + k, start + k + 1]
                start += n
            tris = np.array(tris)
            pos = sources[pos_src][idx[tris, pos_off]][:, :3]
            if nrm_off is not None:
                nrm = sources[nrm_src][idx[tris, nrm_off]][:, :3]
            else:                                  # flat normals from the triangles
                a, b, c = pos[0::3], pos[1::3], pos[2::3]
                nrm = np.repeat(np.cross(b - a, c - a), 3, axis=0)
            pos = (np.c_[pos, np.ones(len(pos))] @ matrix.T)[:, :3]
            nrm = nrm @ np.linalg.inv(matrix[:3, :3])
            nrm /= np.maximum(1e-9, np.linalg.norm(nrm, axis=1))[:, None]
            colour = tuple(np.round(materials.get(binds.get(prim.get('material'), prim.get('material')), np.ones(3)), 4))
            parts.setdefault(colour, []).append((pos, nrm))

    def walk(node, parent):
        matrix = parent
        for t in node:
            tag = t.tag.split('}')[1]
            if tag == 'matrix':
                matrix = matrix @ floats(t.text).reshape(4, 4)
            elif tag == 'translate':
                m = np.eye(4); m[:3, 3] = floats(t.text); matrix = matrix @ m
            elif tag == 'scale':
                matrix = matrix @ np.diag([*floats(t.text), 1])
            elif tag == 'rotate':
                x, y, z, deg = floats(t.text); a = np.radians(deg)
                axis = np.array([x, y, z]) / np.linalg.norm([x, y, z])
                K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
                m = np.eye(4); m[:3, :3] = np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K
                matrix = matrix @ m
        for t in node:
            tag = t.tag.split('}')[1]
            if tag == 'instance_geometry':
                binds = {b.get('symbol'): b.get('target')[1:] for b in t.findall('.//c:instance_material', NS)}
                mesh(geometries[t.get('url')[1:]], matrix, binds)
            elif tag == 'node':
                walk(t, matrix)

    for node in root.findall('.//c:visual_scene/c:node', NS):
        walk(node, np.eye(4))

    out = []
    allpos = np.concatenate([p for chunks in parts.values() for p, _ in chunks])
    centre = (allpos.min(0) + allpos.max(0)) / 2
    radius = np.linalg.norm(allpos - centre, axis=1).max()
    swap = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]]) if z_up else np.eye(3)    # Z up -> Y up
    for colour, chunks in parts.items():
        pos = np.concatenate([p for p, _ in chunks])
        nrm = np.concatenate([n for _, n in chunks])
        pos = ((pos - centre) / radius) @ swap.T
        nrm = nrm @ swap.T
        out.append((colour, pos.astype(np.float32), nrm.astype(np.float32)))
    return out


def save(parts, path):
    with open(path, 'wb') as f:
        f.write(struct.pack('<I', len(parts)))
        for colour, pos, nrm in parts:
            f.write(struct.pack('<3fI', *colour, len(pos)))
            p = np.c_[np.round(pos * 32767), np.zeros(len(pos))].astype('<i2')
            n = np.c_[np.round(nrm * 127), np.zeros(len(nrm))].astype('i1')
            f.write(np.concatenate([p.view('u1').reshape(-1, 8), n.view('u1').reshape(-1, 4)], axis=1).tobytes())


if __name__ == '__main__':
    parts = load(sys.argv[1])
    save(parts, sys.argv[2])
    for colour, pos, _ in parts:
        print(sys.argv[2], 'colour', colour, 'vertices', len(pos), 'bbox', pos.min(0).round(2), pos.max(0).round(2))
