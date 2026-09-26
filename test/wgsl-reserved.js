// Flags identifiers declared with let/var/fn/const that are WGSL reserved words.
import fs from 'node:fs';
import path from 'node:path';

const RESERVED = new Set(`NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await
become binding_array cast catch class co_await co_return co_yield coherent column_major common compile
compile_fragment concept const_cast consteval constexpr constinit crate debugger decltype delete demote
demote_to_helper do dynamic_cast enum explicit export extends extern external fallthrough filter final finally
friend from fxgroup get goto groupshared highp impl implements import inline instanceof interface layout lowp
macro macro_rules match mediump meta mod module move mut mutable namespace new nil noexcept noinline
nointerpolation noperspective null nullptr of operator package packoffset partition pass patch pixelfragment
precise precision premerge priv protected pub public readonly ref regardless register reinterpret_cast require
resource restrict self set shared sizeof smooth snorm static static_assert static_cast std subroutine super
target template this thread_local throw trait try type typedef typeid typename typeof union unless unorm unsafe
unsized use using varying virtual volatile wgsl where with writeonly yield`.split(/\s+/));

let bad = 0;
const walk = d => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.wgsl')) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        for (const m of code.matchAll(/\b(?:let|var|const|fn)\s+([A-Za-z_]\w*)|\b([A-Za-z_]\w*)\s*:\s*(?:f32|i32|u32|vec|mat|bool|array|ptr|texture|sampler)/g)) {
          const id = m[1] ?? m[2];
          if (RESERVED.has(id)) {
            console.log(`${p}:${i + 1}: '${id}' is a WGSL reserved word`);
            bad++;
          }
        }
      });
    }
  }
};
walk('src/shaders');
process.exit(bad ? 1 : 0);
