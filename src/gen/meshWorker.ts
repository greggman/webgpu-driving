// Web Worker: builds car body and cabin meshes off the main thread (a
// curve-body car takes a noticeable fraction of a second) and transfers the
// vertex arrays back. See CarRenderer.request().
import {CarKind, buildCarBody, buildTrailer, carSpec} from './car';
import {buildInterior} from './interior';

self.onmessage = (e: MessageEvent<{kind: CarKind}>) => {
  const kind = e.data.kind;
  const spec = carSpec(kind);
  const body = kind === 'trailer' ? buildTrailer() : buildCarBody(spec);
  const interior = buildInterior(spec);
  (self as unknown as Worker).postMessage({kind, body, interior}, [
    body.vertices.buffer,
    interior.vertices.buffer,
  ]);
};
