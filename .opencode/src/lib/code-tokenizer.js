import { readFileSync, existsSync } from "fs";
import { BertTokenizer as BertTokenizerClass } from "./bert-tokenizer.js";
const BPE_PATTERN = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
export class CodeBertTokenizer {
    constructor(vocabPath, mergesPath) {
        this.bpeRanks = new Map();
        this.config = this.loadVocab(vocabPath);
        if (mergesPath && existsSync(mergesPath)) {
            this.loadMerges(mergesPath);
        }
    }
    loadVocab(vocabPath) {
        if (!existsSync(vocabPath)) {
            throw new Error(`Vocabulary file not found: ${vocabPath}`);
        }
        const vocabContent = readFileSync(vocabPath, "utf-8");
        const vocabLines = vocabContent.split("\n").filter(l => l.trim());
        const vocab = new Map();
        const invVocab = new Map();
        for (let i = 0; i < vocabLines.length; i++) {
            const token = vocabLines[i].trim();
            if (token) {
                vocab.set(token, i);
                invVocab.set(i, token);
            }
        }
        return {
            vocab,
            merges: new Map(),
            invVocab,
            bosToken: "<s>",
            eosToken: "</s>",
            unkToken: "<unk>",
            padToken: "<pad>",
            maxLen: 512,
        };
    }
    loadMerges(mergesPath) {
        const mergesContent = readFileSync(mergesPath, "utf-8");
        const mergesLines = mergesContent.split("\n").filter(l => l.trim());
        for (let i = 0; i < mergesLines.length; i++) {
            const line = mergesLines[i].trim();
            if (line && !line.startsWith("#")) {
                this.bpeRanks.set(line, i);
            }
        }
    }
    tokenize(text) {
        const tokens = this.bpeTokenize(text);
        return tokens;
    }
    encode(text, addSpecialTokens = true) {
        const tokens = this.tokenize(text);
        const ids = tokens.map(t => this.config.vocab.get(t) ?? this.config.vocab.get(this.config.unkToken));
        if (addSpecialTokens) {
            const bosId = this.config.vocab.get(this.config.bosToken);
            const eosId = this.config.vocab.get(this.config.eosToken);
            return [bosId, ...ids, eosId];
        }
        return ids;
    }
    bpeTokenize(text) {
        const tokens = [];
        const matches = text.matchAll(BPE_PATTERN);
        for (const match of matches) {
            const token = match[0];
            const bpeTokens = this.applyBPE(token);
            tokens.push(...bpeTokens);
        }
        return tokens;
    }
    applyBPE(token) {
        let word = token.split("");
        word = word.map((c, i) => i === 0 ? c : " " + c);
        if (word.length === 0)
            return [token];
        while (word.length > 1) {
            let bestPair = null;
            let bestRank = Infinity;
            for (let i = 0; i < word.length - 1; i++) {
                const pair = word[i] + " " + word[i + 1];
                const rank = this.bpeRanks.get(pair);
                if (rank !== undefined && rank < bestRank) {
                    bestRank = rank;
                    bestPair = [i, i + 1];
                }
            }
            if (bestPair === null)
                break;
            const newWord = [];
            for (let i = 0; i < word.length; i++) {
                if (bestPair && i === bestPair[0]) {
                    newWord.push(word[bestPair[0]] + word[bestPair[1]].slice(1));
                    i++;
                }
                else {
                    newWord.push(word[i]);
                }
            }
            word = newWord;
        }
        return word.map(w => w.replace(/ /g, ""));
    }
    getVocabSize() {
        return this.config.vocab.size;
    }
    getUnkTokenId() {
        return this.config.vocab.get(this.config.unkToken) ?? 0;
    }
    getBosTokenId() {
        return this.config.vocab.get(this.config.bosToken) ?? 0;
    }
    getEosTokenId() {
        return this.config.vocab.get(this.config.eosToken) ?? 2;
    }
    getPadTokenId() {
        return this.config.vocab.get(this.config.padToken) ?? 1;
    }
    convertIdsToTokens(ids) {
        return ids.map(id => this.config.invVocab.get(id) ?? this.config.unkToken);
    }
}
export function createTokenizer(vocabPath, modelType) {
    switch (modelType) {
        case "codebert":
        case "unixcoder":
            return new CodeBertTokenizer(vocabPath);
        default:
            return new BertTokenizerClass(vocabPath);
    }
}
//# sourceMappingURL=code-tokenizer.js.map