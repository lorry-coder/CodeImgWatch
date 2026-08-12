import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { BaseImageParser } from './baseParser';
import {
    ParseResult,
    ImageMetadata,
    PixelDepth,
    PixelDepthSize,
    ChannelFormat,
    decodeCvType,
    formatCvType,
} from '../types';
import { calculateDataSize } from '../utils/imageTransform';

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
        try {
            const members = evaluateResult.variablesReference > 0
                ? await session.getVariables(evaluateResult.variablesReference)
                : [];
            const memberMap = new Map(members.map(m => [m.name, m]));
            const typeName = evaluateResult.type ?? '';

            const rows = this.getMemberInt(memberMap, 'rows') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'rows')
            );
            const cols = this.getMemberInt(memberMap, 'cols') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'cols')
            );
            const type = this.getMemberInt(memberMap, 'type') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'type')
            );
            const step = this.getMemberInt(memberMap, 'step') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'step')
            );

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
            const dataExpression = this.getMemberExpression(expression, typeName, 'data');
            dataAddress = await this.evaluateAsPointer(session, `${dataExpression}.ptr`);

            if (!dataAddress) {
                // Try direct data access
                const dataMember = memberMap.get('data');
                if (dataMember && dataMember.variablesReference > 0) {
                    const dataMembers = await session.getVariables(dataMember.variablesReference);
                    const ptrMember = dataMembers.find(m => m.name === 'ptr');
                    if (ptrMember) {
                        dataAddress = this.parsePointerValue(ptrMember.value) ?? ptrMember.memoryReference;
                    }
                }
            }

            if (!dataAddress || this.isNullPointerValue(dataAddress)) {
                return this.errorResult('CvMat data pointer is null');
            }

            // Calculate stride if not provided
            let stride = step;
            if (stride === undefined) {
                return this.errorResult('Failed to read CvMat row stride');
            }
            if (stride === 0) {
                stride = cols * PixelDepthSize[depth] * channels;
            }

            const validationError = this.getImageValidationError(cols, rows, channels, depth, stride);
            if (validationError) {
                return this.errorResult(validationError);
            }

            const channelFormat = channels === 1
                ? ChannelFormat.GRAY
                : channels === 3
                    ? ChannelFormat.BGR
                    : channels === 4
                        ? ChannelFormat.BGRA
                        : undefined;

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
                dataSize: 0,
                channelFormat,
                isContinuous: stride === cols * PixelDepthSize[depth] * channels,
                debuggerType: session.getDebuggerType(),
                frameId: session.currentFrameId,
            };
            metadata.dataSize = calculateDataSize(metadata);

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
        return /^_?IplImage\s*[&*]?$/.test(normalized);
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        try {
            const members = evaluateResult.variablesReference > 0
                ? await session.getVariables(evaluateResult.variablesReference)
                : [];
            const memberMap = new Map(members.map(m => [m.name, m]));
            const typeName = evaluateResult.type ?? '';

            const width = this.getMemberInt(memberMap, 'width') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'width')
            );
            const height = this.getMemberInt(memberMap, 'height') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'height')
            );
            const nChannels = this.getMemberInt(memberMap, 'nChannels') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'nChannels')
            );
            const iplDepth = this.getMemberInt(memberMap, 'depth') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'depth')
            );
            const widthStep = this.getMemberInt(memberMap, 'widthStep') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'widthStep')
            );
            const origin = this.getMemberInt(memberMap, 'origin') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'origin')
            );
            const dataOrder = this.getMemberInt(memberMap, 'dataOrder') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'dataOrder')
            );

            if (width === undefined || height === undefined) {
                return this.errorResult('Failed to read IplImage dimensions');
            }

            if (nChannels === undefined) {
                return this.errorResult('Failed to read IplImage channel count');
            }
            if (iplDepth === undefined) {
                return this.errorResult('Failed to read IplImage depth');
            }
            if (origin !== undefined && origin !== 0) {
                return this.errorResult('Bottom-left IplImage origins are not supported');
            }
            if (dataOrder !== undefined && dataOrder !== 0) {
                return this.errorResult('Planar IplImage data is not supported');
            }

            const roiMember = memberMap.get('roi');
            const roiAddress = roiMember
                ? this.parsePointerValue(roiMember.value) ?? roiMember.memoryReference
                : await this.evaluateAsPointer(
                    session,
                    this.getMemberExpression(expression, typeName, 'roi')
                );
            if (roiAddress && !this.isNullPointerValue(roiAddress)) {
                return this.errorResult('IplImage ROI metadata is not supported; visualize a cv::Mat ROI instead');
            }

            // Convert IPL depth to CV depth
            const depth = this.iplDepthToCvDepth(iplDepth);
            if (depth === undefined) {
                return this.errorResult(`Unknown IplImage depth: ${iplDepth}`);
            }

            // Get imageData pointer
            let dataAddress: string | undefined;
            const imageDataMember = memberMap.get('imageData');
            if (imageDataMember) {
                dataAddress = this.parsePointerValue(imageDataMember.value) ?? imageDataMember.memoryReference;
            }

            if (!dataAddress) {
                dataAddress = await this.evaluateAsPointer(
                    session,
                    this.getMemberExpression(expression, typeName, 'imageData')
                );
            }

            if (!dataAddress || this.isNullPointerValue(dataAddress)) {
                return this.errorResult('IplImage imageData pointer is null');
            }

            let stride = widthStep;
            if (stride === undefined) {
                return this.errorResult('Failed to read IplImage row stride');
            }
            if (stride === 0) {
                stride = width * PixelDepthSize[depth] * nChannels;
            }

            const validationError = this.getImageValidationError(width, height, nChannels, depth, stride);
            if (validationError) {
                return this.errorResult(validationError);
            }

            const channelFormat = nChannels === 1
                ? ChannelFormat.GRAY
                : nChannels === 3
                    ? ChannelFormat.BGR
                    : nChannels === 4
                        ? ChannelFormat.BGRA
                        : undefined;

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
                dataSize: 0,
                channelFormat,
                isContinuous: stride === width * PixelDepthSize[depth] * nChannels,
                debuggerType: session.getDebuggerType(),
                frameId: session.currentFrameId,
                rawProperties: {
                    iplDepth,
                    origin,
                    dataOrder,
                },
            };
            metadata.dataSize = calculateDataSize(metadata);

            return this.successResult(metadata, ['Using legacy IplImage type; consider upgrading to cv::Mat']);
        } catch (error) {
            return this.errorResult(`Failed to parse IplImage: ${error}`);
        }
    }

    /**
     * Convert IPL depth code to OpenCV depth
     */
    private iplDepthToCvDepth(iplDepth: number): PixelDepth | undefined {
        const normalizedDepth = iplDepth >>> 0;
        // IPL_DEPTH constants
        const IPL_DEPTH_8U = 8;
        const IPL_DEPTH_8S = 0x80000008;
        const IPL_DEPTH_16U = 16;
        const IPL_DEPTH_16S = 0x80000010;
        const IPL_DEPTH_32S = 0x80000020;
        const IPL_DEPTH_32F = 32;
        const IPL_DEPTH_64F = 64;

        switch (normalizedDepth) {
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
