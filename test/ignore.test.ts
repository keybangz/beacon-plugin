import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shouldIndex, validatePatterns } from '../src/lib/ignore.js';
import pm from "picomatch";

// Mock picomatch
vi.mock("picomatch");
const mockPm = pm as ReturnType<typeof vi.fn>;

describe('File Ignore Patterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPm.mockImplementation((pattern: string) => {
      // Check for invalid patterns and throw errors
      if (pattern.includes('invalid[') && !pattern.endsWith(']')) {
        throw new Error('Invalid syntax in pattern');
      }
      
      // Simple mock implementation that matches basic patterns
      if (pattern === '**/*.ts') return (filePath: string) => filePath.endsWith('.ts');
      if (pattern === '**/*.js') return (filePath: string) => filePath.endsWith('.js');
      if (pattern === 'node_modules/**') return (filePath: string) => filePath.includes('node_modules');
      if (pattern === 'dist/**') return (filePath: string) => filePath.includes('dist');
      return () => true; // Default: match everything
    });
  });

  describe('shouldIndex', () => {
    it('should include files that match include patterns', () => {
      const filePath = 'src/test.ts';
      const include = ['**/*.ts', '**/*.js'];
      const exclude = ['node_modules/**'];
      
      const result = shouldIndex(filePath, include, exclude);
      
      expect(result).toBe(true);
    });

    it('should exclude files that match exclude patterns', () => {
      const filePath = 'node_modules/test.js';
      const include = ['**/*.ts', '**/*.js'];
      const exclude = ['node_modules/**'];
      
      const result = shouldIndex(filePath, include, exclude);
      
      expect(result).toBe(false);
    });

    it('should prioritize exclude patterns over include patterns', () => {
      const filePath = 'node_modules/valid.ts';
      const include = ['**/*.ts'];
      const exclude = ['node_modules/**'];
      
      const result = shouldIndex(filePath, include, exclude);
      
      expect(result).toBe(false);
    });

    it('should handle file paths without extensions', () => {
      const filePath = 'Makefile';
      const include = ['**/*.ts'];
      const exclude = [];
      
      const result = shouldIndex(filePath, include, exclude);
      
      expect(result).toBe(false);
    });

    it('should handle complex nested paths', () => {
      const testCases = [
        {
          filePath: 'src/components/Button.tsx',
          include: ['**/*.tsx'],
          exclude: [],
          expected: true,
        },
        {
          filePath: 'src/components/Button.test.tsx',
          include: ['**/*.tsx'],
          exclude: ['**/*.test.*'],
          expected: false,
        },
        {
          filePath: 'src/utils/helpers.js',
          include: ['**/*.ts'],
          exclude: [],
          expected: false,
        },
        {
          filePath: 'dist/bundle.js',
          include: ['**/*.ts', '**/*.js'],
          exclude: ['dist/**'],
          expected: false,
        },
      ];
      
      testCases.forEach(({ filePath, include, exclude, expected }) => {
        const result = shouldIndex(filePath, include, exclude);
        expect(result).toBe(expected);
      });
    });

    it('should handle empty include patterns', () => {
      const filePath = 'any/file.js';
      const include: string[] = [];
      const exclude = ['node_modules/**'];
      
      const result = shouldIndex(filePath, include, exclude);
      
      expect(result).toBe(false);
    });

    it('should handle empty exclude patterns', () => {
      const filePath = 'node_modules/test.js';
      const include = ['**/*.js'];
      const exclude: string[] = [];
      
      const result = shouldIndex(filePath, include, exclude);
      
      expect(result).toBe(true);
    });

    it('should handle no patterns at all', () => {
      const filePath = 'any/file.js';
      const include: string[] = [];
      const exclude: string[] = [];
      
      const result = shouldIndex(filePath, include, exclude);
      
      expect(result).toBe(false);
    });

    it('should match multiple include patterns', () => {
      const filePath = 'src/index.js';
      const include = ['**/*.ts', '**/*.js', '**/*.jsx'];
      const exclude = [];
      
      const result = shouldIndex(filePath, include, exclude);
      
      expect(result).toBe(true);
    });

    it('should respect pattern precedence', () => {
      const testCases = [
        {
          description: 'Specific exclusion beats general inclusion',
          filePath: 'node_modules/lib/index.js',
          include: ['**/*.js'],
          exclude: ['node_modules/**'],
          expected: false,
        },
        {
          description: 'More specific exclusion beats less specific',
          filePath: 'src/test.spec.ts',
          include: ['**/*.ts'],
          exclude: ['**/*.spec.*'],
          expected: false,
        },
        {
          description: 'File without matching include pattern',
          filePath: 'src/Dockerfile',
          include: ['**/*.ts', '**/*.js'],
          exclude: [],
          expected: false,
        },
      ];
      
      testCases.forEach(({ filePath, include, exclude, expected }) => {
        const result = shouldIndex(filePath, include, exclude);
        expect(result).toBe(expected);
      });
    });
  });

  describe('Pattern Validation', () => {
    it('should validate correct patterns', () => {
      const validPatterns = ['**/*.ts', '**/*.js', 'src/**'];
      
      expect(() => validatePatterns(validPatterns)).not.toThrow();
    });

    it('should throw for invalid patterns', () => {
      const invalidPatterns = ['invalid[ pattern', '**/*.ts'];
      
      expect(() => validatePatterns(invalidPatterns)).toThrow();
    });
  });

  describe('Edge Cases', () => {
    it('should handle hidden files', () => {
      const testCases = [
        {
          filePath: '.env.local',
          include: ['**/*'],
          exclude: ['**/.env*'],
          expected: false,
        },
        {
          filePath: '.eslintrc.js',
          include: ['**/*.js'],
          exclude: [],
          expected: true,
        },
        {
          filePath: '.config/config.json',
          include: ['**/*.json'],
          exclude: ['**/.config/**'],
          expected: false,
        },
      ];
      
      testCases.forEach(({ filePath, include, exclude, expected }) => {
        const result = shouldIndex(filePath, include, exclude);
        expect(result).toBe(expected);
      });
    });

    it('should handle file with special characters', () => {
      const filePath = 'src/utils/file-with-dashes_underscores.js';
      const include = ['**/*.js'];
      const exclude = [];
      
      const result = shouldIndex(filePath, include, exclude);
      
      expect(result).toBe(true);
    });

    it('should handle root level files', () => {
      const testCases = [
        {
          filePath: 'package.json',
          include: ['**/*.json'],
          exclude: [],
          expected: true,
        },
        {
          filePath: 'README.md',
          include: ['**/*.md'],
          exclude: [],
          expected: true,
        },
        {
          filePath: 'tsconfig.json',
          include: ['**/*.json'],
          exclude: [],
          expected: true,
        },
      ];
      
      testCases.forEach(({ filePath, include, exclude, expected }) => {
        const result = shouldIndex(filePath, include, exclude);
        expect(result).toBe(expected);
      });
    });

    it('should handle deeply nested files', () => {
      const filePath = 'src/components/features/user-profile/__tests__/UserProfile.test.tsx';
      const include = ['**/*.tsx'];
      const exclude = ['**/*.test.*'];
      
      const result = shouldIndex(filePath, include, exclude);
      
      expect(result).toBe(false);
    });
  });
});