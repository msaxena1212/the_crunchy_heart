#!/usr/bin/env node

/**
 * The Crunchy Heart - Owner Account Provisioning Tool (Hardened Phase 3.3.2)
 *
 * Securely provisions or updates an owner account in the admin_users table
 * using modern scrypt password hashing with cryptographically random salts.
 *
 * SECURITY INVARIANTS:
 * 1. Passwords are NEVER accepted as command-line arguments (prevents shell history and process table exposure).
 * 2. Passwords are entered interactively via a muted terminal prompt (no echoing to stdout).
 * 3. Passwords must be confirmed twice and must be at least 8 characters long.
 * 4. Fails closed if executed in a non-interactive environment without a TTY.
 * 5. Existing owner accounts require explicit user confirmation before profile/password updates.
 * 6. Never logs or prints passwords, hashes, or sensitive input.
 *
 * Usage:
 *   node src/scripts/create-owner.js <email> [fullName]
 *   npm run admin:create -- <email> [fullName]
 *
 * Example:
 *   node src/scripts/create-owner.js owner@thecrunchyheart.com "Store Owner"
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { query, pool } from '../db/pool.js';
import { hashPassword } from '../utils/admin-token.js';

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate email format.
 */
export function validateEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const clean = email.trim();
    return clean.length >= 3 && clean.includes('@') && !clean.startsWith('@') && !clean.endsWith('@');
}

/**
 * Validate password requirements.
 */
export function validatePassword(password) {
    if (!password || typeof password !== 'string') {
        return { valid: false, error: 'Password cannot be blank.' };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
        return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.` };
    }
    return { valid: true };
}

/**
 * Validate password confirmation match.
 */
export function validatePasswordConfirmation(password, confirmation) {
    const passVal = validatePassword(password);
    if (!passVal.valid) return passVal;

    if (password !== confirmation) {
        return { valid: false, error: 'Passwords do not match. Provisioning aborted.' };
    }
    return { valid: true };
}

/**
 * Parse and validate command-line arguments.
 * Strictly prohibits passing passwords on the command line.
 */
export function parseProvisioningArgs(args = []) {
    if (!Array.isArray(args) || args.length === 0) {
        return {
            valid: false,
            error: 'Missing required email argument.\nUsage: node src/scripts/create-owner.js <email> [fullName]\nPassword must be entered interactively at the secure prompt.',
        };
    }

    // Reject password flags
    const hasForbiddenFlag = args.some(
        (arg) =>
            typeof arg === 'string' &&
            (arg.startsWith('--password') ||
                arg === '-p' ||
                arg.startsWith('-p=') ||
                arg.startsWith('--pass'))
    );
    if (hasForbiddenFlag) {
        return {
            valid: false,
            error: 'Password flags are strictly prohibited. Passwords must never be passed via command-line arguments.',
        };
    }

    // Limit argument count to strictly: email, [fullName]
    if (args.length > 2) {
        return {
            valid: false,
            error: `Too many arguments provided (${args.length}). Do NOT provide passwords on the command line.\nUsage: node src/scripts/create-owner.js <email> [fullName]`,
        };
    }

    const email = args[0]?.trim();
    if (!validateEmail(email)) {
        return {
            valid: false,
            error: 'Please provide a valid email address containing "@".',
        };
    }

    const fullName = args[1]?.trim() || 'Store Owner';

    return {
        valid: true,
        email: email.toLowerCase(),
        fullName,
    };
}

/**
 * Securely prompt for a password from terminal with echo disabled.
 * Fails closed if terminal is non-interactive.
 */
export function promptHidden(queryText, { stdin = process.stdin, stdout = process.stdout } = {}) {
    return new Promise((resolve, reject) => {
        if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
            return reject(
                new Error(
                    'Interactive terminal (TTY) is required for secure hidden password entry. Refusing non-interactive execution.'
                )
            );
        }

        stdout.write(queryText);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        let password = '';

        const onData = (chunk) => {
            for (const char of chunk) {
                // Ctrl+C (SIGINT)
                if (char === '\u0003') {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.removeListener('data', onData);
                    stdout.write('\n');
                    process.exit(130);
                }
                // Enter / Return
                if (char === '\r' || char === '\n') {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.removeListener('data', onData);
                    stdout.write('\n');
                    resolve(password);
                    return;
                }
                // Backspace / Delete
                if (char === '\u0008' || char === '\x7f') {
                    if (password.length > 0) {
                        password = password.slice(0, -1);
                    }
                } else if (char.charCodeAt(0) >= 32) {
                    password += char;
                }
            }
        };

        stdin.on('data', onData);
    });
}

/**
 * Prompt for standard confirmation (e.g., y/N) from terminal.
 */
export function promptConfirmation(queryText, { stdin = process.stdin, stdout = process.stdout } = {}) {
    return new Promise((resolve, reject) => {
        if (!stdin.isTTY) {
            return reject(
                new Error('Interactive terminal (TTY) is required for user confirmation.')
            );
        }

        const rl = readline.createInterface({ input: stdin, output: stdout });
        rl.question(queryText, (answer) => {
            rl.close();
            resolve((answer || '').trim());
        });
    });
}

/**
 * Check if an owner account already exists in database.
 */
export async function checkExistingAccount(queryFn, email) {
    const result = await queryFn(
        `
        SELECT id, email, full_name, role, is_active
        FROM admin_users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
        `,
        [email]
    );
    return result.rows[0] || null;
}

/**
 * Execute upsert of owner account in database using scrypt hash.
 */
export async function provisionOwnerAccount(queryFn, { email, password, fullName }) {
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
        throw new Error(passwordValidation.error);
    }

    const hashedPassword = hashPassword(password);
    const cleanEmail = email.toLowerCase().trim();

    const result = await queryFn(
        `
        INSERT INTO admin_users (
            email,
            password_hash,
            full_name,
            role,
            is_active,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, 'ADMIN', true, NOW(), NOW())
        ON CONFLICT (LOWER(email)) DO UPDATE
        SET
            password_hash = EXCLUDED.password_hash,
            full_name = EXCLUDED.full_name,
            is_active = true,
            updated_at = NOW()
        RETURNING id, email, full_name, role, is_active
        `,
        [cleanEmail, hashedPassword, fullName]
    );

    return result.rows[0];
}

/**
 * Main CLI execution entry point.
 */
export async function main() {
    const args = process.argv.slice(2);
    const parsed = parseProvisioningArgs(args);

    if (!parsed.valid) {
        console.error(`Error: ${parsed.error}`);
        process.exit(1);
    }

    // Fail closed if executed outside an interactive TTY
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
        console.error(
            'Error: Interactive terminal (TTY) is required for secure hidden password entry. Non-interactive execution is rejected.'
        );
        process.exit(1);
    }

    try {
        // Step 1: Check if an owner account already exists
        const existing = await checkExistingAccount(query, parsed.email);
        if (existing) {
            console.log(
                `Notice: An owner account with email "${existing.email}" already exists (Name: "${existing.full_name}", ID: ${existing.id}).`
            );
            const answer = await promptConfirmation(
                'Do you want to update this owner account\'s password and profile? (y/N): '
            );
            if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
                console.log('Update cancelled. Existing owner account was not modified.');
                process.exit(0);
            }
        }

        // Step 2: Prompt for password twice with muted echo
        const password = await promptHidden('Enter owner password (min 8 characters, input hidden): ');
        const passVal = validatePassword(password);
        if (!passVal.valid) {
            console.error(`Error: ${passVal.error}`);
            process.exit(1);
        }

        const confirmPassword = await promptHidden('Confirm owner password (input hidden): ');
        const confirmVal = validatePasswordConfirmation(password, confirmPassword);
        if (!confirmVal.valid) {
            console.error(`Error: ${confirmVal.error}`);
            process.exit(1);
        }

        // Step 3: Provision account
        const admin = await provisionOwnerAccount(query, {
            email: parsed.email,
            password,
            fullName: parsed.fullName,
        });

        console.log('✅ Owner account provisioned successfully:');
        console.log(`   ID:        ${admin.id}`);
        console.log(`   Email:     ${admin.email}`);
        console.log(`   Name:      ${admin.full_name}`);
        console.log(`   Role:      ${admin.role}`);
        console.log(`   Active:    ${admin.is_active}`);
    } catch (error) {
        console.error('Failed to provision owner account:', error.message || error);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

// Execute main only when run directly from CLI
const isDirectRun =
    process.argv[1] &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
    main().catch((err) => {
        console.error('Fatal provisioning error:', err);
        process.exit(1);
    });
}
