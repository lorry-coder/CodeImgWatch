import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { BaseImageParser } from './baseParser';
import { ParseResult, ImageMetadata, PixelDepth, PixelDepthSize, formatCvType } from '../types';

/**
 * Map template type names to pixel depth
 */
const TEMPLATE_TYPE_MAP: Record<string, PixelDepth> = {
    'uchar': PixelDepth.CV_8U,
    'unsigned char': PixelDepth.CV_8U,
    'uint8_t': PixelDepth.CV_8U,
    'schar': PixelDepth.CV_8S,
    'signed char': PixelDepth.CV_8S,
    'int8_t': PixelDepth.CV_8S,
    'char': PixelDepth.CV_8S,
    'ushort': PixelDepth.CV_16U,
    'unsigned short': PixelDepth.CV_16U,
    'uint16_t': PixelDepth.CV_16U,
    'short': PixelDepth.CV_16S,
    'int16_t': PixelDepth.CV_16S,
    'int': PixelDepth.CV_32S,
    'int32_t': PixelDepth.CV_32S,
    'float': PixelDepth.CV_32F,
    'double': PixelDepth.CV_64F,
};

/**
 * Parser for cv::Mat_<T> template type
 */
export class CvMatTemplateParser extends BaseImageParser {
    readonly name = 'cv::Mat_<T>';
    readonly priority = 110; // Higher priority than cv::Mat

    canParse(typeName: string): boolean {
        const normalized = typeName.replace(/^(const\s+)?(class\s+|struct\s+)?/, '').trim();
        return /^cv::Mat_</.test(normalized);
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        const variablesRef = evaluateResult.variablesReference;

        if (variablesRef === 0) {
            return this.errorResult('Cannot access cv::Mat_<T> structure members');
        }

        try {
            // Extract template type from evaluateResult.type
            const templateType = this.extractTemplateType(evaluateResult.type ?? '');
            const depthFromTemplate = templateType ? this.getDepthFromTemplateType(templateType) : undefined;

            // Get all members
            const members = await session.getVariables(variablesRef);
            const memberMap = new Map(members.map(m => [m.name, m]));

            // cv::Mat_<T> inherits from cv::Mat, so we can access the same members
            const rows = this.getMemberInt(memberMap, 'rows');
            const cols = this.getMemberInt(memberMap, 'cols');
            const flags = this.getMemberInt(memberMap, 'flags');

            if (rows === undefined || cols === undefined) {
                return this.errorResult('Failed to read cv::Mat_<T> dimensions');
            }

            if (flags === undefined) {
                return this.errorResult('Failed to read cv::Mat_<T> flags');
            }

            // Determine depth and channels
            let depth: PixelDepth;
            let channels: number;

            if (depthFromTemplate !== undefined) {
                // Use template type info
                const typeInfo = this.parseVecType(templateType!);
                if (typeInfo) {
                    depth = typeInfo.depth;
                    channels = typeInfo.channels;
                } else {
                    depth = depthFromTemplate;
                    channels = 1;
                }
            } else {
                // Fall back to flags
                const cvType = flags & 0xFFF;
                depth = cvType & 7;
                channels = ((cvType >> 3) & 63) + 1;
            }

            // Get data pointer
            let dataAddress: string | undefined;
            const dataMember = memberMap.get('data');
            if (dataMember?.memoryReference) {
                dataAddress = dataMember.memoryReference;
            } else if (dataMember) {
                dataAddress = this.parsePointerValue(dataMember.value);
            }

            if (!dataAddress) {
                dataAddress = await this.evaluateAsPointer(session, `${expression}.data`);
            }

            if (!dataAddress || dataAddress === '0x0') {
                return this.errorResult('cv::Mat_<T> data pointer is null');
            }

            // Get stride
            let stride = await this.evaluateAsInt(session, `(int)${expression}.step[0]`);
            if (stride === undefined) {
                const pixelSize = PixelDepthSize[depth] * channels;
                stride = cols * pixelSize;
            }

            const dataSize = stride * rows;

            if (rows <= 0 || cols <= 0) {
                return this.errorResult(`Invalid dimensions: ${cols}x${rows}`);
            }

            const metadata: ImageMetadata = {
                id: this.generateImageId(expression),
                name: expression,
                expression,
                typeName: `cv::Mat_<${templateType ?? 'unknown'}>`,
                depth,
                channels,
                width: cols,
                height: rows,
                stride,
                dataAddress,
                dataSize,
                isContinuous: (flags & (1 << 14)) !== 0,
                debuggerType: session.getDebuggerType(),
                frameId: session.currentFrameId,
            };

            return this.successResult(metadata);
        } catch (error) {
            return this.errorResult(`Failed to parse cv::Mat_<T>: ${error}`);
        }
    }

    /**
     * Extract template type from full type name
     */
    private extractTemplateType(typeName: string): string | undefined {
        const match = typeName.match(/cv::Mat_<(.+?)>(?:\s*[&*])?$/);
        if (match) {
            return match[1].trim();
        }
        return undefined;
    }

    /**
     * Get pixel depth from template type string
     */
    private getDepthFromTemplateType(templateType: string): PixelDepth | undefined {
        // Check for cv::Vec types first
        const vecInfo = this.parseVecType(templateType);
        if (vecInfo) {
            return vecInfo.depth;
        }

        // Check direct type mapping
        const normalized = templateType.replace(/\s+/g, ' ').trim();
        return TEMPLATE_TYPE_MAP[normalized];
    }

    /**
     * Parse cv::Vec type (e.g., cv::Vec3b, cv::Vec4f)
     */
    private parseVecType(templateType: string): { depth: PixelDepth; channels: number } | undefined {
        const vecMatch = templateType.match(/cv::Vec(\d+)([bsifwd])/i);
        if (vecMatch) {
            const channels = parseInt(vecMatch[1], 10);
            const typeSuffix = vecMatch[2].toLowerCase();
            const depthMap: Record<string, PixelDepth> = {
                'b': PixelDepth.CV_8U,
                's': PixelDepth.CV_16S,
                'i': PixelDepth.CV_32S,
                'f': PixelDepth.CV_32F,
                'd': PixelDepth.CV_64F,
                'w': PixelDepth.CV_16U,
            };
            const depth = depthMap[typeSuffix];
            if (depth !== undefined) {
                return { depth, channels };
            }
        }
        return undefined;
    }

    private getMemberInt(memberMap: Map<string, { value: string }>, name: string): number | undefined {
        const member = memberMap.get(name);
        if (member) {
            return this.parseIntValue(member.value);
        }
        return undefined;
    }
}
