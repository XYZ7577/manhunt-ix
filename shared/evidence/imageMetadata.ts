export type ImageMetadataAltitudeReference = 'above sea level' | 'below sea level';

export interface ImageMetadataResponse {
    evidence: { id: string; filename: string; mediaType: string; size: number };
    summary: {
        capturedAtLocal: string | null;
        capturedAtOffset: string | null;
        latitude: number | null;
        longitude: number | null;
        altitudeMeters: number | null;
        altitudeReference: ImageMetadataAltitudeReference | null;
        make: string | null;
        model: string | null;
    };
    sections: Array<{ name: string; entries: Array<{ name: string; value: string }> }>;
    notice: string | null;
}
