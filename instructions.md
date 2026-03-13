---
description: "Custom instructions for CLI Tool development with TypeScript and Node.js"
applyTo: "**"
---

# CLI Tool Development Guidelines

## Programming Language: TypeScript

**TypeScript Best Practices:**
- Use strict TypeScript configuration with `"strict": true`
- Prefer interfaces over type aliases for object shapes
- Use explicit return types for all public functions
- Avoid `any` type - use `unknown` or proper typing instead
- Use utility types (Pick, Omit, Partial) for type transformations
- Implement proper null/undefined checking

## Framework: Node.js


## Code Style: Functional Programming

**Functional Programming Guidelines:**
- Prefer pure functions without side effects
- Use immutable data structures when possible
- Favor composition over inheritance
- Avoid global state and mutations
- Use higher-order functions and function composition
- Implement proper error handling with Result/Either types

## Project-Specific Guidelines

This is a Claude Code plugin we are going to be completely redeveloping for OpenCode, we must make sure agents automatically use the finished plugin, and use it correctly.

## AI Code Generation Preferences

When generating code, please:

- Generate complete, working code examples with proper imports
- Include inline comments for complex logic and business rules
- Follow the established patterns and conventions in this project
- Suggest improvements and alternative approaches when relevant
- Consider performance, security, and maintainability
- Include error handling and edge case considerations
- Generate appropriate unit tests when creating new functions
- Follow accessibility best practices for UI components
- Use semantic HTML and proper ARIA attributes when applicable
