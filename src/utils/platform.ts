import * as os from 'os';
import * as path from 'path';

/**
 * Platform types
 */
export type Platform = 'windows' | 'linux' | 'darwin' | 'unknown';

/**
 * Get current platform
 */
export function getPlatform(): Platform {
    const platform = os.platform();
    switch (platform) {
        case 'win32':
            return 'windows';
        case 'linux':
            return 'linux';
        case 'darwin':
            return 'darwin';
        default:
            return 'unknown';
    }
}

/**
 * Check if running on Windows
 */
export function isWindows(): boolean {
    return getPlatform() === 'windows';
}

/**
 * Check if running on Linux
 */
export function isLinux(): boolean {
    return getPlatform() === 'linux';
}

/**
 * Check if running on macOS
 */
export function isMacOS(): boolean {
    return getPlatform() === 'darwin';
}

/**
 * Get architecture
 */
export function getArchitecture(): string {
    return os.arch();
}

/**
 * Check if running on x86/x64
 */
export function isX86(): boolean {
    const arch = getArchitecture();
    return arch === 'ia32' || arch === 'x64';
}

/**
 * Normalize path for the current platform
 */
export function normalizePath(filepath: string): string {
    if (isWindows()) {
        // Convert forward slashes to backslashes on Windows
        return filepath.replace(/\//g, '\\');
    }
    // Convert backslashes to forward slashes on Unix
    return filepath.replace(/\\/g, '/');
}

/**
 * Get path separator for current platform
 */
export function getPathSeparator(): string {
    return path.sep;
}

/**
 * Format address for display (handle 32/64 bit differences)
 */
export function formatAddress(address: string): string {
    // Normalize to lowercase hex
    let normalized = address.toLowerCase();

    // Ensure 0x prefix
    if (!normalized.startsWith('0x')) {
        normalized = '0x' + normalized;
    }

    // Pad to appropriate width based on architecture
    const arch = getArchitecture();
    const width = arch === 'x64' ? 16 : 8;

    const hex = normalized.slice(2);
    return '0x' + hex.padStart(width, '0');
}

/**
 * Parse address string to bigint
 */
export function parseAddress(address: string): bigint {
    if (address.startsWith('0x') || address.startsWith('0X')) {
        return BigInt(address);
    }
    return BigInt('0x' + address);
}

/**
 * Add offset to address
 */
export function addAddressOffset(address: string, offset: number): string {
    const addr = parseAddress(address);
    const newAddr = addr + BigInt(offset);
    return '0x' + newAddr.toString(16);
}

/**
 * Platform-specific debugger type hints
 */
export interface DebuggerHints {
    /** Expected pointer size in bytes */
    pointerSize: number;
    /** Common type name variations */
    typeAliases: Record<string, string[]>;
    /** Member name variations */
    memberAliases: Record<string, string[]>;
}

/**
 * Get debugger hints for MSVC debugger
 */
export function getMsvcDebuggerHints(): DebuggerHints {
    return {
        pointerSize: getArchitecture() === 'x64' ? 8 : 4,
        typeAliases: {
            'cv::Mat': ['class cv::Mat', 'struct cv::Mat'],
            'size_t': ['unsigned __int64', 'unsigned int'],
        },
        memberAliases: {
            'data': ['data', 'pData'],
            'step': ['step', 'mStep'],
        },
    };
}

/**
 * Get debugger hints for GDB
 */
export function getGdbDebuggerHints(): DebuggerHints {
    return {
        pointerSize: getArchitecture() === 'x64' ? 8 : 4,
        typeAliases: {
            'cv::Mat': ['cv::Mat'],
            'size_t': ['size_t', 'unsigned long', 'unsigned long long'],
        },
        memberAliases: {
            'data': ['data'],
            'step': ['step'],
        },
    };
}

/**
 * Get debugger hints for LLDB
 */
export function getLldbDebuggerHints(): DebuggerHints {
    return {
        pointerSize: getArchitecture() === 'x64' ? 8 : 4,
        typeAliases: {
            'cv::Mat': ['cv::Mat'],
            'size_t': ['size_t', 'unsigned long'],
        },
        memberAliases: {
            'data': ['data'],
            'step': ['step'],
        },
    };
}

/**
 * Get debugger hints based on debugger type
 */
export function getDebuggerHints(debuggerType: string): DebuggerHints {
    switch (debuggerType) {
        case 'cppvsdbg':
            return getMsvcDebuggerHints();
        case 'cppdbg':
            return getGdbDebuggerHints();
        case 'lldb':
            return getLldbDebuggerHints();
        default:
            return getGdbDebuggerHints();
    }
}
