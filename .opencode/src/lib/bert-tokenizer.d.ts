export declare class BertTokenizer {
    private config;
    constructor(vocabPath: string);
    private loadVocab;
    tokenize(text: string): string[];
    encode(text: string, addSpecialTokens?: boolean): number[];
    encodePair(textA: string, textB: string): number[];
    private basicTokenize;
    private cleanText;
    private stripAccents;
    private splitOnPunctuation;
    private isControl;
    private isWhitespace;
    private isPunctuation;
    private wordpieceTokenize;
    getVocabSize(): number;
    getUnkTokenId(): number;
    getClsTokenId(): number;
    getSepTokenId(): number;
    getPadTokenId(): number;
    convertIdsToTokens(ids: number[]): string[];
    convertTokensToString(tokens: string[]): string;
}
export declare function getDefaultTokenizer(): BertTokenizer;
//# sourceMappingURL=bert-tokenizer.d.ts.map