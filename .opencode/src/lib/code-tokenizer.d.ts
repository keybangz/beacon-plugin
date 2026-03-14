import type { BertTokenizer } from "./bert-tokenizer.js";
export declare class CodeBertTokenizer {
    private config;
    private bpeRanks;
    constructor(vocabPath: string, mergesPath?: string);
    private loadVocab;
    private loadMerges;
    tokenize(text: string): string[];
    encode(text: string, addSpecialTokens?: boolean): number[];
    private bpeTokenize;
    private applyBPE;
    getVocabSize(): number;
    getUnkTokenId(): number;
    getBosTokenId(): number;
    getEosTokenId(): number;
    getPadTokenId(): number;
    convertIdsToTokens(ids: number[]): string[];
}
export declare function createTokenizer(vocabPath: string, modelType: "bert" | "codebert" | "unixcoder"): BertTokenizer | CodeBertTokenizer;
//# sourceMappingURL=code-tokenizer.d.ts.map