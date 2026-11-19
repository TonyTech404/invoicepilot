// Shows the original document with the regions Document Intelligence read.
// The focused field's region is highlighted, so a reviewer can see where every value came from.
import { useEffect, useRef, useState } from 'react';
import type { Box, PageSize } from '../../../shared/types';

export interface Region {
  key: string;
  box: Box;
}

interface Props {
  url: string;
  mime: string;
  pages: PageSize[];
  regions: Region[];
  active: string | null;
  onPick?: (key: string) => void;
}

type Rendered = { src: string; width: number; height: number };

async function renderPdf(url: string): Promise<Rendered[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const data = new Uint8Array(await (await fetch(url, { credentials: 'same-origin' })).arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const out: Rendered[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, 3); n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, viewport }).promise;
    out.push({ src: canvas.toDataURL('image/png'), width: viewport.width, height: viewport.height });
  }
  return out;
}

export function DocumentViewer({ url, mime, pages, regions, active, onPick }: Props) {
  const [rendered, setRendered] = useState<Rendered[] | null>(null);
  const [failed, setFailed] = useState(false);
  const activeRef = useRef<SVGPolygonElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRendered(null);
    setFailed(false);
    if (mime === 'application/pdf') {
      renderPdf(url)
        .then((r) => !cancelled && setRendered(r))
        .catch(() => !cancelled && setFailed(true));
    } else {
      const img = new Image();
      img.onload = () => !cancelled && setRendered([{ src: url, width: img.naturalWidth, height: img.naturalHeight }]);
      img.onerror = () => !cancelled && setFailed(true);
      img.src = url;
    }
    return () => {
      cancelled = true;
    };
  }, [url, mime]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);

  if (failed) {
    return (
      <div className="sheet flex aspect-[1/1.414] items-center justify-center p-8 text-center text-ink-soft">
        The document could not be displayed. <a className="ml-1 underline" href={url}>Open it</a>
      </div>
    );
  }
  if (!rendered) {
    return <div className="sheet aspect-[1/1.414] animate-pulse" aria-label="Loading document" />;
  }

  return (
    <div className="space-y-4">
      {rendered.map((page, i) => {
        const size = pages[i];
        // Regions arrive in the page's units: inches for PDFs, pixels for images.
        const scale = size ? page.width / size.width : 1;
        const pageRegions = regions.filter((r) => r.box.page === i + 1);
        return (
          <div key={i} className="sheet relative overflow-hidden">
            <img src={page.src} alt={`Page ${i + 1} of the invoice`} className="block h-auto w-full" />
            <svg viewBox={`0 0 ${page.width} ${page.height}`} className="absolute inset-0 h-full w-full" aria-hidden={!onPick}>
              {pageRegions.map((r) => {
                const isActive = r.key === active;
                const pts = r.box.polygon.map((v) => v * scale);
                const pairs: string[] = [];
                for (let k = 0; k + 1 < pts.length; k += 2) pairs.push(`${pts[k]},${pts[k + 1]}`);
                const points = pairs.join(' ');
                return (
                  <polygon
                    key={r.key}
                    ref={isActive ? activeRef : undefined}
                    points={points}
                    onClick={() => onPick?.(r.key)}
                    className="cursor-pointer transition-[fill,stroke] duration-150"
                    fill={isActive ? 'rgb(245 213 71 / 0.45)' : 'rgb(31 92 70 / 0.06)'}
                    stroke={isActive ? '#a15c07' : 'rgb(31 92 70 / 0.35)'}
                    strokeWidth={isActive ? 4 : 2}
                    strokeLinejoin="round"
                  />
                );
              })}
            </svg>
          </div>
        );
      })}
    </div>
  );
}
