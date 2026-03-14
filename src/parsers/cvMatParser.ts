import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { BaseImageParser } from './baseParser';
import { ParseResult, ImageMetadata, PixelDepth, PixelDepthSize, decodeCvType, formatCvType } from '../types';

/**
 * Parser for cv::Mat type
 */
export class CvMatParser extends BaseImageParser {
    readonly name = 'cv::Mat';
    readonly priority = 100;

    canParse(typeName: string): boolean {
        // Match cv::Mat but not cv::Mat_ or cv::Matx
        const normalized = typeName.replace(/^(const\s+)?(class\s+|struct\s+)?/, '').trim();
        return /^cv::Mat\s*[&*]?$/.test(normalized) || normalized === 'cv::Mat';
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        const variablesRef = evaluateResult.variablesReference;

        if (variablesRef === 0) {
            return this.errorResult('Cannot access cv::Mat structure members');
        }

        try {
            // Get all members at once for efficiency
            const members = await session.getVariables(variablesRef);
            const memberMap = new Map(members.map(m => [m.name, m]));

            // Extract required fields
            const rows = this.getMemberInt(memberMap, 'rows');
            const cols = this.getMemberInt(memberMap, 'cols');
            const flags = this.getMemberInt(memberMap, 'flags');
            const dims = this.getMemberInt(memberMap, 'dims');

            // Validate required fields
            if (rows === undefined || cols === undefined) {
                return this.errorResult('Failed to read cv::Mat dimensions (rows/cols)');
            }

            if (flags === undefined) {
                return this.errorResult('Failed to read cv::Mat flags field');
            }

            // Decode type from flags
            const cvType = flags & 0xFFF; // CV_MAT_TYPE_MASK
            const { depth, channels } = decodeCvType(cvType);

            // Get data pointer
            let dataAddress: string | undefined;

            // Try memoryReference first
            const dataMember = memberMap.get('data');
            if (dataMember?.memoryReference) {
                dataAddress = dataMember.memoryReference;
            } else if (dataMember) {
                dataAddress = this.parsePointerValue(dataMember.value);
            }

            // If not found, try evaluating the expression
            if (!dataAddress) {
                dataAddress = await this.evaluateAsPointer(session, `${expression}.data`);
            }

            if (!dataAddress) {
                return this.errorResult('Failed to read cv::Mat data pointer');
            }

            // Check for null pointer
            if (dataAddress === '0x0' || dataAddress === '0x00000000' || dataAddress === '0x0000000000000000') {
                return this.errorResult('cv::Mat data pointer is null (empty matrix)');
            }

            // Get step (stride) - step is an array, we need step[0]
            let stride: number | undefined;

            // Try to get step.p[0] or step[0]
            const stepMember = memberMap.get('step');
            if (stepMember && stepMember.variablesReference > 0) {
                // step is a MatStep object, get its buffer
                const stepMembers = await session.getVariables(stepMember.variablesReference);
                const pMember = stepMembers.find(m => m.name === 'p' || m.name === 'buf');
                if (pMember && pMember.variablesReference > 0) {
                    const pMembers = await session.getVariables(pMember.variablesReference);
                    const step0 = pMembers.find(m => m.name === '[0]' || m.name === '0');
                    if (step0) {
                        stride = this.parseIntValue(step0.value);
                    }
                }
            }

            // Fallback: evaluate step[0] directly
            if (stride === undefined) {
                stride = await this.evaluateAsInt(session, `(int)${expression}.step[0]`);
            }

            // Fallback: calculate from width and pixel size
            if (stride === undefined) {
                const pixelSize = PixelDepthSize[depth] * channels;
                stride = cols * pixelSize;
            }

            // Check continuous flag
            const CV_MAT_CONT_FLAG = 1 << 14;
            const isContinuous = (flags & CV_MAT_CONT_FLAG) !== 0;

            // Calculate data size
            const dataSize = stride * rows;

            // Validate dimensions
            if (rows <= 0 || cols <= 0) {
                return this.errorResult(`Invalid cv::Mat dimensions: ${cols}x${rows}`);
            }

            // Check for reasonable size
            const maxDim = 16384;
            if (rows > maxDim || cols > maxDim) {
                return this.errorResult(`cv::Mat dimensions too large: ${cols}x${rows} (max: ${maxDim}x${maxDim})`);
            }

            const metadata: ImageMetadata = {
                id: this.generateImageId(expression),
                name: expression,
                expression,
                typeName: formatCvType(depth, channels),
                depth,
                channels,
                width: cols,
                height: rows,
                stride,
                dataAddress,
                dataSize,
                isContinuous,
                debuggerType: session.getDebuggerType(),
                frameId: session.currentFrameId,
                rawProperties: {
                    flags,
                    dims: dims ?? 2,
                    cvType,
                },
            };

            const warnings: string[] = [];
            if (!isContinuous) {
                warnings.push('Matrix is not continuous in memory; reading may be slower');
            }

            return this.successResult(metadata, warnings.length > 0 ? warnings : undefined);
        } catch (error) {
            return this.errorResult(`Failed to parse cv::Mat: ${error}`);
        }
    }

    /**
     * Get integer value from member map
     */
    private getMemberInt(memberMap: Map<string, { value: string }>, name: string): number | undefined {
        const member = memberMap.get(name);
        if (member) {
            return this.parseIntValue(member.value);
        }
        return undefined;
    }
}
