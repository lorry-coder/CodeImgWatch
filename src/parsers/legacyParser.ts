import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { BaseImageParser } from './baseParser';
import { ParseResult, ImageMetadata, PixelDepth, PixelDepthSize, decodeCvType, formatCvType } from '../types';

/**
 * Parser for legacy CvMat type (OpenCV C interface)
 *
 * CvMat structure:
 * - type: int (contains depth and channels)
 * - step: int (row stride)
 * - rows: int
 * - cols: int
 * - data: union { uchar* ptr; short* s; int* i; float* fl; double* db; }
 */
export class CvMatLegacyParser extends BaseImageParser {
    readonly name = 'CvMat';
    readonly priority = 50;

    canParse(typeName: string): boolean {
        const normalized = typeName.replace(/^(const\s+)?(struct\s+)?/, '').trim();
        return /^CvMat\s*[&*]?$/.test(normalized) || normalized === 'CvMat';
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        const variablesRef = evaluateResult.variablesReference;

        if (variablesRef === 0) {
            return this.errorResult('Cannot access CvMat structure members');
        }

        try {
            const members = await session.getVariables(variablesRef);
            const memberMap = new Map(members.map(m => [m.name, m]));

            const rows = this.getMemberInt(memberMap, 'rows');
            const cols = this.getMemberInt(memberMap, 'cols');
            const type = this.getMemberInt(memberMap, 'type');
            const step = this.getMemberInt(memberMap, 'step');

            if (rows === undefined || cols === undefined) {
                return this.errorResult('Failed to read CvMat dimensions');
            }

            if (type === undefined) {
                return this.errorResult('Failed to read CvMat type');
            }

            const { depth, channels } = decodeCvType(type);

            // Get data pointer from union
            let dataAddress: string | undefined;

            // Try data.ptr first
            dataAddress = await this.evaluateAsPointer(session, `${expression}.data.ptr`);

            if (!dataAddress) {
                // Try direct data access
                const dataMember = memberMap.get('data');
                if (dataMember && dataMember.variablesReference > 0) {
                    const dataMembers = await session.getVariables(dataMember.variablesReference);
                    const ptrMember = dataMembers.find(m => m.name === 'ptr');
                    if (ptrMember) {
                        dataAddress = ptrMember.memoryReference ?? this.parsePointerValue(ptrMember.value);
                    }
                }
            }

            if (!dataAddress || dataAddress === '0x0') {
                return this.errorResult('CvMat data pointer is null');
            }

            // Calculate stride if not provided
            let stride = step;
            if (stride === undefined || stride === 0) {
                stride = cols * PixelDepthSize[depth] * channels;
            }

            const dataSize = stride * rows;

            if (rows <= 0 || cols <= 0) {
                return this.errorResult(`Invalid CvMat dimensions: ${cols}x${rows}`);
            }

            const metadata: ImageMetadata = {
                id: this.generateImageId(expression),
                name: expression,
                expression,
                typeName: `CvMat (${formatCvType(depth, channels)})`,
                depth,
                channels,
                width: cols,
                height: rows,
                stride,
                dataAddress,
                dataSize,
                isContinuous: stride === cols * PixelDepthSize[depth] * channels,
                debuggerType: session.getDebuggerType(),
                frameId: session.currentFrameId,
            };

            return this.successResult(metadata, ['Using legacy CvMat type; consider upgrading to cv::Mat']);
        } catch (error) {
            return this.errorResult(`Failed to parse CvMat: ${error}`);
        }
    }

    private getMemberInt(memberMap: Map<string, { value: string }>, name: string): number | undefined {
        const member = memberMap.get(name);
        if (member) {
            return this.parseIntValue(member.value);
        }
        return undefined;
    }
}

/**
 * Parser for legacy IplImage type (OpenCV 1.x / Intel IPP)
 *
 * IplImage structure:
 * - nSize: int (sizeof(IplImage))
 * - nChannels: int
 * - depth: int (IPL depth code, not CV depth)
 * - width: int
 * - height: int
 * - imageData: char*
 * - widthStep: int (row stride)
 */
export class IplImageParser extends BaseImageParser {
    readonly name = 'IplImage';
    readonly priority = 45;

    canParse(typeName: string): boolean {
        const normalized = typeName.replace(/^(const\s+)?(struct\s+)?/, '').trim();
        return /^(\_)?IplImage\s*[&*]?$/.test(normalized);
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        const variablesRef = evaluateResult.variablesReference;

        if (variablesRef === 0) {
            return this.errorResult('Cannot access IplImage structure members');
        }

        try {
            const members = await session.getVariables(variablesRef);
            const memberMap = new Map(members.map(m => [m.name, m]));

            const width = this.getMemberInt(memberMap, 'width');
            const height = this.getMemberInt(memberMap, 'height');
            const nChannels = this.getMemberInt(memberMap, 'nChannels');
            const iplDepth = this.getMemberInt(memberMap, 'depth');
            const widthStep = this.getMemberInt(memberMap, 'widthStep');

            if (width === undefined || height === undefined) {
                return this.errorResult('Failed to read IplImage dimensions');
            }

            if (nChannels === undefined) {
                return this.errorResult('Failed to read IplImage channel count');
            }

            // Convert IPL depth to CV depth
            const depth = this.iplDepthToCvDepth(iplDepth ?? 8);
            if (depth === undefined) {
                return this.errorResult(`Unknown IplImage depth: ${iplDepth}`);
            }

            // Get imageData pointer
            let dataAddress: string | undefined;
            const imageDataMember = memberMap.get('imageData');
            if (imageDataMember) {
                dataAddress = imageDataMember.memoryReference ?? this.parsePointerValue(imageDataMember.value);
            }

            if (!dataAddress) {
                dataAddress = await this.evaluateAsPointer(session, `${expression}.imageData`);
            }

            if (!dataAddress || dataAddress === '0x0') {
                return this.errorResult('IplImage imageData pointer is null');
            }

            let stride = widthStep;
            if (stride === undefined || stride === 0) {
                stride = width * PixelDepthSize[depth] * nChannels;
            }

            const dataSize = stride * height;

            if (width <= 0 || height <= 0) {
                return this.errorResult(`Invalid IplImage dimensions: ${width}x${height}`);
            }

            const metadata: ImageMetadata = {
                id: this.generateImageId(expression),
                name: expression,
                expression,
                typeName: `IplImage (${formatCvType(depth, nChannels)})`,
                depth,
                channels: nChannels,
                width,
                height,
                stride,
                dataAddress,
                dataSize,
                isContinuous: stride === width * PixelDepthSize[depth] * nChannels,
                debuggerType: session.getDebuggerType(),
                frameId: session.currentFrameId,
                rawProperties: {
                    iplDepth,
                },
            };

            return this.successResult(metadata, ['Using legacy IplImage type; consider upgrading to cv::Mat']);
        } catch (error) {
            return this.errorResult(`Failed to parse IplImage: ${error}`);
        }
    }

    /**
     * Convert IPL depth code to OpenCV depth
     */
    private iplDepthToCvDepth(iplDepth: number): PixelDepth | undefined {
        // IPL_DEPTH constants
        const IPL_DEPTH_8U = 8;
        const IPL_DEPTH_8S = 0x80000008;
        const IPL_DEPTH_16U = 16;
        const IPL_DEPTH_16S = 0x80000010;
        const IPL_DEPTH_32S = 0x80000020;
        const IPL_DEPTH_32F = 32;
        const IPL_DEPTH_64F = 64;

        switch (iplDepth) {
            case IPL_DEPTH_8U:
                return PixelDepth.CV_8U;
            case IPL_DEPTH_8S:
                return PixelDepth.CV_8S;
            case IPL_DEPTH_16U:
                return PixelDepth.CV_16U;
            case IPL_DEPTH_16S:
                return PixelDepth.CV_16S;
            case IPL_DEPTH_32S:
                return PixelDepth.CV_32S;
            case IPL_DEPTH_32F:
                return PixelDepth.CV_32F;
            case IPL_DEPTH_64F:
                return PixelDepth.CV_64F;
            default:
                return undefined;
        }
    }

    private getMemberInt(memberMap: Map<string, { value: string }>, name: string): number | undefined {
        const member = memberMap.get(name);
        if (member) {
            return this.parseIntValue(member.value);
        }
        return undefined;
    }
}
