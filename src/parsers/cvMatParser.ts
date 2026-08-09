import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { BaseImageParser } from './baseParser';
import { ParseResult, ImageMetadata, PixelDepthSize, ChannelFormat, decodeCvType, formatCvType } from '../types';
import { calculateDataSize } from '../utils/imageTransform';

/**
 * Parser for cv::Mat type
 */
export class CvMatParser extends BaseImageParser {
    readonly name = 'cv::Mat';
    readonly priority = 100;

    canParse(typeName: string): boolean {
        // Match cv::Mat but not cv::Mat_ or cv::Matx
        const normalized = typeName.replace(/^(const\s+)?(class\s+|struct\s+)?/, '').trim();
        return /^cv::Mat\s*[&*]?(?:\s+const)?$/.test(normalized) || normalized === 'cv::Mat';
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        try {
            // Get all members at once for efficiency
            const members = evaluateResult.variablesReference > 0
                ? await session.getVariables(evaluateResult.variablesReference)
                : [];
            const memberMap = new Map(members.map(m => [m.name, m]));
            const typeName = evaluateResult.type ?? '';

            // Extract required fields
            const rows = this.getMemberInt(memberMap, 'rows') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'rows')
            );
            const cols = this.getMemberInt(memberMap, 'cols') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'cols')
            );
            const flags = this.getMemberInt(memberMap, 'flags') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'flags')
            );
            const dims = this.getMemberInt(memberMap, 'dims') ?? await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, 'dims')
            );

            // Validate required fields
            if (rows === undefined || cols === undefined) {
                return this.errorResult('Failed to read cv::Mat dimensions (rows/cols)');
            }

            if (flags === undefined) {
                return this.errorResult('Failed to read cv::Mat flags field');
            }
            if (dims !== undefined && dims !== 2) {
                return this.errorResult(`Unsupported ${dims}D cv::Mat (only 2D matrices can be displayed)`);
            }

            // Decode type from flags
            const cvType = flags & 0xFFF; // CV_MAT_TYPE_MASK
            const { depth, channels } = decodeCvType(cvType);

            // Get data pointer
            let dataAddress: string | undefined;

            // Try memoryReference first
            const dataMember = memberMap.get('data');
            if (dataMember) {
                dataAddress = this.parsePointerValue(dataMember.value) ?? dataMember.memoryReference;
            }

            // If not found, try evaluating the expression
            if (!dataAddress) {
                dataAddress = await this.evaluateAsPointer(
                    session,
                    this.getMemberExpression(expression, typeName, 'data')
                );
            }

            if (!dataAddress) {
                return this.errorResult('Failed to read cv::Mat data pointer');
            }

            // Check for null pointer
            if (this.isNullPointerValue(dataAddress)) {
                return this.errorResult('cv::Mat data pointer is null (empty matrix)');
            }

            // Check continuous flag before deciding whether a packed-stride fallback is safe.
            const CV_MAT_CONT_FLAG = 1 << 14;
            const isContinuous = (flags & CV_MAT_CONT_FLAG) !== 0;

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

            // MatStep::operator[] is not available in some DAP evaluators.
            const stepExpression = this.getMemberExpression(expression, typeName, 'step');
            if (stride === undefined) {
                stride = await this.evaluateAsInt(session, `${stepExpression}.p[0]`);
            }
            if (stride === undefined) {
                stride = await this.evaluateAsInt(session, `${stepExpression}.buf[0]`);
            }
            if (stride === undefined) {
                stride = await this.evaluateAsInt(session, `${stepExpression}[0]`);
            }

            // A packed fallback is correct only for a continuous matrix. For an ROI or
            // externally backed Mat, guessing here silently shifts every row.
            if (stride === undefined) {
                if (!isContinuous) {
                    return this.errorResult('Failed to read row stride for non-continuous cv::Mat');
                }
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
                typeName: formatCvType(depth, channels),
                depth,
                channels,
                width: cols,
                height: rows,
                stride,
                dataAddress,
                dataSize: 0,
                channelFormat,
                isContinuous,
                debuggerType: session.getDebuggerType(),
                frameId: session.currentFrameId,
                rawProperties: {
                    flags,
                    dims: dims ?? 2,
                    cvType,
                },
            };
            metadata.dataSize = calculateDataSize(metadata);

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
