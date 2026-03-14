import { readFileSync, existsSync } from "fs";
import { join } from "path";
export class BertTokenizer {
    constructor(vocabPath) {
        this.config = this.loadVocab(vocabPath);
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
            invVocab,
            unkToken: "[UNK]",
            clsToken: "[CLS]",
            sepToken: "[SEP]",
            padToken: "[PAD]",
            maxLen: 512,
            doLowerCase: true,
        };
    }
    tokenize(text) {
        if (this.config.doLowerCase) {
            text = text.toLowerCase();
        }
        const tokens = this.basicTokenize(text);
        const wordpieceTokens = [];
        for (const token of tokens) {
            const subTokens = this.wordpieceTokenize(token);
            wordpieceTokens.push(...subTokens);
        }
        return wordpieceTokens;
    }
    encode(text, addSpecialTokens = true) {
        const tokens = this.tokenize(text);
        const ids = tokens.map(t => this.config.vocab.get(t) ?? this.config.vocab.get(this.config.unkToken));
        if (addSpecialTokens) {
            const clsId = this.config.vocab.get(this.config.clsToken);
            const sepId = this.config.vocab.get(this.config.sepToken);
            return [clsId, ...ids, sepId];
        }
        return ids;
    }
    encodePair(textA, textB) {
        const tokensA = this.tokenize(textA);
        const tokensB = this.tokenize(textB);
        const idsA = tokensA.map(t => this.config.vocab.get(t) ?? this.config.vocab.get(this.config.unkToken));
        const idsB = tokensB.map(t => this.config.vocab.get(t) ?? this.config.vocab.get(this.config.unkToken));
        const clsId = this.config.vocab.get(this.config.clsToken);
        const sepId = this.config.vocab.get(this.config.sepToken);
        return [clsId, ...idsA, sepId, ...idsB, sepId];
    }
    basicTokenize(text) {
        text = this.cleanText(text);
        const origTokens = text.split(/\s+/).filter(t => t.length > 0);
        const splitTokens = [];
        for (const token of origTokens) {
            if (this.config.doLowerCase) {
                const lowered = token.toLowerCase();
                const normalized = this.stripAccents(lowered);
                splitTokens.push(...this.splitOnPunctuation(normalized));
            }
            else {
                splitTokens.push(...this.splitOnPunctuation(token));
            }
        }
        return splitTokens.filter(t => t.length > 0);
    }
    cleanText(text) {
        const sb = [];
        for (const char of text) {
            const cp = char.codePointAt(0);
            if (cp === 0 || cp === 0xFFFD || this.isControl(char)) {
                continue;
            }
            if (this.isWhitespace(char)) {
                sb.push(" ");
            }
            else {
                sb.push(char);
            }
        }
        return sb.join("");
    }
    stripAccents(text) {
        return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
    splitOnPunctuation(text) {
        const result = [];
        let current = "";
        for (const char of text) {
            if (this.isPunctuation(char)) {
                if (current.length > 0) {
                    result.push(current);
                    current = "";
                }
                result.push(char);
            }
            else {
                current += char;
            }
        }
        if (current.length > 0) {
            result.push(current);
        }
        return result;
    }
    isControl(char) {
        const cp = char.codePointAt(0);
        if (char === "\t" || char === "\n" || char === "\r")
            return false;
        if (cp >= 0x00 && cp <= 0x1F)
            return true;
        if (cp >= 0x7F && cp <= 0x9F)
            return true;
        return false;
    }
    isWhitespace(char) {
        return /\s/.test(char);
    }
    isPunctuation(char) {
        const cp = char.codePointAt(0);
        if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) ||
            (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
            return true;
        }
        const category = char;
        if (/[^\w\s]/.test(category)) {
            return true;
        }
        return false;
    }
    wordpieceTokenize(token) {
        const unkToken = this.config.unkToken;
        const maxWordLength = 100;
        if (token.length > maxWordLength) {
            return [unkToken];
        }
        let isBad = false;
        let start = 0;
        const subTokens = [];
        while (start < token.length) {
            let end = token.length;
            let currentSubstr = "";
            while (start < end) {
                const substr = token.slice(start, end);
                const prefix = start > 0 ? "##" + substr : substr;
                if (this.config.vocab.has(prefix)) {
                    currentSubstr = prefix;
                    break;
                }
                end--;
            }
            if (currentSubstr.length === 0) {
                isBad = true;
                break;
            }
            subTokens.push(currentSubstr);
            start = end;
        }
        if (isBad) {
            return [unkToken];
        }
        return subTokens;
    }
    getVocabSize() {
        return this.config.vocab.size;
    }
    getUnkTokenId() {
        return this.config.vocab.get(this.config.unkToken) ?? 0;
    }
    getClsTokenId() {
        return this.config.vocab.get(this.config.clsToken) ?? 101;
    }
    getSepTokenId() {
        return this.config.vocab.get(this.config.sepToken) ?? 102;
    }
    getPadTokenId() {
        return this.config.vocab.get(this.config.padToken) ?? 0;
    }
    convertIdsToTokens(ids) {
        return ids.map(id => this.config.invVocab.get(id) ?? this.config.unkToken);
    }
    convertTokensToString(tokens) {
        return tokens
            .filter(t => t !== this.config.clsToken && t !== this.config.sepToken)
            .map(t => t.startsWith("##") ? t.slice(2) : (t === this.config.padToken ? "" : " " + t))
            .join("")
            .trim();
    }
}
let defaultTokenizer = null;
export function getDefaultTokenizer() {
    if (!defaultTokenizer) {
        const vocabPath = join(process.cwd(), ".beacon", "vocab.txt");
        const fallbackPath = join(process.cwd(), "models", "vocab.txt");
        if (existsSync(vocabPath)) {
            defaultTokenizer = new BertTokenizer(vocabPath);
        }
        else if (existsSync(fallbackPath)) {
            defaultTokenizer = new BertTokenizer(fallbackPath);
        }
        else {
            throw new Error("Vocabulary file not found. Expected .beacon/vocab.txt or models/vocab.txt");
        }
    }
    return defaultTokenizer;
}
//# sourceMappingURL=bert-tokenizer.js.map