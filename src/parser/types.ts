/**
 * 文件解析器模块的类型定义。
 * 定义策略接口和解析结果类型。
 */

/**
 * 文件解析的策略接口。
 * 每种支持的文件格式都实现此接口。
 */
export interface FileParserStrategy {
  supportedExtensions: string[];
  parse(buffer: Buffer, filename: string): Promise<ParseResult>;
}

/**
 * 文件解析操作的结果。
 */
export interface ParseResult {
  success: boolean;
  content: string;
  metadata: {
    filename: string;
    format: string;
    pageCount?: number;
    nodeCount?: number;
  };
  error?: string;
}
