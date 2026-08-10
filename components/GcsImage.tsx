import React, { useEffect, useRef, useState } from 'react';
import { fetchObjectAsBlobUrl } from '../services/projects';

/**
 * Renders an image stored in the private app bucket.
 *
 * A plain `<img src="gs://...">` obviously cannot work, and a signed URL is
 * cross-origin against a bucket with no CORS configuration. So the bytes come
 * through the same-origin authenticated proxy and get wrapped in a blob: URL,
 * which is revoked when the component unmounts or the URI changes.
 */
interface GcsImageProps {
    gcsUri: string;
    alt: string;
    className?: string;
    /** Rendered while loading and on failure. */
    fallbackClassName?: string;
}

const GcsImage: React.FC<GcsImageProps> = ({ gcsUri, alt, className, fallbackClassName }) => {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const urlRef = useRef<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setUrl(null);
        setFailed(false);

        fetchObjectAsBlobUrl(gcsUri)
            .then((blobUrl) => {
                if (cancelled) {
                    URL.revokeObjectURL(blobUrl);
                    return;
                }
                urlRef.current = blobUrl;
                setUrl(blobUrl);
            })
            .catch(() => { if (!cancelled) setFailed(true); });

        return () => {
            cancelled = true;
            if (urlRef.current) {
                URL.revokeObjectURL(urlRef.current);
                urlRef.current = null;
            }
        };
    }, [gcsUri]);

    if (url) return <img src={url} alt={alt} className={className} />;

    return (
        <div
            className={fallbackClassName || className}
            role="img"
            aria-label={failed ? `${alt} (unavailable)` : `${alt} (loading)`}
            style={{ background: '#2D2D2D', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
            <span style={{ fontSize: 11, color: failed ? '#EA4335' : '#5f6368' }}>
                {failed ? '✕' : '…'}
            </span>
        </div>
    );
};

export default GcsImage;
