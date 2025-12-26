/**
 * Spellcheck service using nspell (Hunspell) for typo detection.
 * 
 * Provides dictionary-backed spellchecking with domain-specific allowlists
 * to avoid false positives on hospitality/culinary terms.
 * 
 * Must be initialized at boot time via initialize(). No lazy initialization.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nspell = require('nspell');
import { readFile, access, stat } from 'fs/promises';
import { join } from 'path';

type SpellCheckStatus = 'uninitialized' | 'ready' | 'disabled';

interface SpellCheckResult {
  isCorrect: boolean;
  suggestions: string[];
}

class SpellCheckService {
  private static instance: SpellCheckService | null = null;
  private spellEngines: Map<string, ReturnType<typeof nspell>> = new Map();
  private allowlists: Map<string, Set<string>> = new Map();
  private status: SpellCheckStatus = 'uninitialized';
  private statusReason?: string;
  private dictionariesLoaded: string[] = [];
  private allowlistsLoaded: string[] = [];
  private initializedAt?: Date;

  private constructor() {}

  static getInstance(): SpellCheckService {
    if (!SpellCheckService.instance) {
      SpellCheckService.instance = new SpellCheckService();
    }
    return SpellCheckService.instance;
  }

  /**
   * Get current status and diagnostic information.
   */
  getStatus(): {
    status: SpellCheckStatus;
    reason?: string;
    dictionariesLoaded: string[];
    allowlistsLoaded: string[];
    initializedAt?: Date;
  } {
    return {
      status: this.status,
      reason: this.statusReason,
      dictionariesLoaded: this.dictionariesLoaded,
      allowlistsLoaded: this.allowlistsLoaded,
      initializedAt: this.initializedAt,
    };
  }

  /**
   * Initialize the spellcheck service by loading dictionaries and allowlists.
   * Must be called at boot time. Not safe to call during request handling.
   * Idempotent: no-op if already initialized (ready or disabled).
   */
  async initialize(): Promise<void> {
    if (this.status !== 'uninitialized') {
      return; // Already initialized (ready or disabled)
    }

    // Add initialization timeout (10 seconds) with cancellation
    const timeoutMs = 10000;
    const cancelled = { value: false };
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        cancelled.value = true;
        reject(new Error('Initialization timeout after 10s'));
      }, timeoutMs);
    });

    try {
      await Promise.race([this._doInitialize(cancelled), timeoutPromise]);
    } catch (err: any) {
      // Set status immediately on timeout/error
      this.status = 'disabled';
      this.statusReason = err.message || 'Initialization failed';
      console.error(`[SpellCheck] Initialization error: ${this.statusReason}`);
    }
  }

  private async _doInitialize(cancelled: { value: boolean }): Promise<void> {
    // Resolve resources path that works in both dev (tsx) and production (dist/)
    // Production strategy: postbuild script copies src/resources -> dist/resources
    // Path priority:
    //   1. dist/resources (production, from compiled code)
    //   2. src/resources (dev mode, or if dist/resources missing)
    //   3. Project root fallbacks (for edge cases)
    const isCompiled = __dirname.includes('dist');
    const possiblePaths = isCompiled
      ? [
          // Production: prefer dist/resources (copied by postbuild)
          join(__dirname, '../../resources'),      // dist/resources (from dist/src/utils)
          join(__dirname, '../../../src/resources'), // Fallback: src/resources (from dist/src/utils)
          join(process.cwd(), 'dist/resources'),   // Project root relative (dist/)
          join(process.cwd(), 'src/resources'),    // Project root relative (src/)
        ]
      : [
          // Dev mode: prefer src/resources
          join(__dirname, '../resources'),         // src/resources (from src/utils)
          join(process.cwd(), 'src/resources'),   // Project root relative
        ];
    
    let resourcesDir: string | null = null;
    const triedPaths: string[] = [];
    for (const path of possiblePaths) {
      triedPaths.push(path);
      try {
        await access(path);
        resourcesDir = path;
        break;
      } catch {
        // Path doesn't exist, try next
      }
    }
    
    if (!resourcesDir) {
      const errorMsg = `Resources directory not found. Tried paths: ${triedPaths.join(', ')}. ` +
        `Ensure dictionaries are downloaded (run: tsx scripts/download-hunspell-dicts.ts) ` +
        `and resources are accessible. In production, ensure postbuild script copies src/resources to dist/resources.`;
      throw new Error(errorMsg);
    }
    
    // Load Hunspell dictionaries with validation
    const locales = ['en_AU', 'en_US'];
    for (const locale of locales) {
      // Check cancellation flag before each iteration
      if (cancelled.value) {
        throw new Error('Initialization cancelled due to timeout');
      }
      
      try {
        const affPath = join(resourcesDir, 'hunspell', locale, `${locale}.aff`);
        const dicPath = join(resourcesDir, 'hunspell', locale, `${locale}.dic`);
        
        // Validate files exist
        let affExists = false;
        let dicExists = false;
        try {
          await access(affPath);
          affExists = true;
        } catch {
          // File doesn't exist
        }
        try {
          await access(dicPath);
          dicExists = true;
        } catch {
          // File doesn't exist
        }
        
        if (!affExists || !dicExists) {
          console.warn(`[SpellCheck] Missing dictionary files for ${locale}, skipping...`);
          continue;
        }

        // Check cancellation before expensive operations
        if (cancelled.value) {
          throw new Error('Initialization cancelled due to timeout');
        }

        // Validate files are non-empty and meet minimum size requirements
        const affStats = await stat(affPath);
        const dicStats = await stat(dicPath);
        
        const MIN_AFF_SIZE = 1024; // 1KB
        const MIN_DIC_SIZE = 10240; // 10KB
        
        if (affStats.size < MIN_AFF_SIZE) {
          console.warn(`[SpellCheck] ${locale}.aff is too small (${affStats.size} bytes), skipping...`);
          continue;
        }
        
        if (dicStats.size < MIN_DIC_SIZE) {
          console.warn(`[SpellCheck] ${locale}.dic is too small (${dicStats.size} bytes), skipping...`);
          continue;
        }
        
        // Check cancellation before file reads
        if (cancelled.value) {
          throw new Error('Initialization cancelled due to timeout');
        }
        
        const aff = await readFile(affPath);
        const dic = await readFile(dicPath);
        
        // Double-check non-empty after read
        if (aff.length === 0 || dic.length === 0) {
          console.warn(`[SpellCheck] Empty dictionary files for ${locale}, skipping...`);
          continue;
        }
        
        // Check cancellation before nspell initialization
        if (cancelled.value) {
          throw new Error('Initialization cancelled due to timeout');
        }
        
        const spell = nspell(aff, dic);
        this.spellEngines.set(locale, spell);
        this.dictionariesLoaded.push(locale);
      } catch (err: any) {
        // If cancelled, re-throw to stop initialization
        if (cancelled.value || err.message?.includes('cancelled')) {
          throw err;
        }
        console.warn(`[SpellCheck] Failed to load ${locale} dictionary: ${err.message}`);
      }
    }

    // Load allowlists
    const allowlistFiles = ['culinary_en.txt', 'units_abbrev.txt'];
    for (const filename of allowlistFiles) {
      // Check cancellation before each allowlist
      if (cancelled.value) {
        throw new Error('Initialization cancelled due to timeout');
      }
      
      try {
        const path = join(resourcesDir, 'dicts', filename);
        const allowlist = await this.loadAllowlistFile(path);
        const key = filename.replace('.txt', '');
        this.allowlists.set(key, allowlist);
        this.allowlistsLoaded.push(key);
      } catch (err: any) {
        // If cancelled, re-throw to stop initialization
        if (cancelled.value || err.message?.includes('cancelled')) {
          throw err;
        }
        console.warn(`[SpellCheck] Failed to load allowlist ${filename}: ${err.message}`);
      }
    }

    // Set status based on what loaded
    if (this.spellEngines.size > 0) {
      this.status = 'ready';
      this.initializedAt = new Date();
      const dicts = this.dictionariesLoaded.join(', ');
      console.log(`[SpellCheck] ✅ READY with dictionaries: ${dicts || 'none'}`);
    } else {
      this.status = 'disabled';
      this.statusReason = 'No dictionaries loaded';
      console.warn(`[SpellCheck] ⚠️ DISABLED: No dictionaries loaded. Run: tsx scripts/download-hunspell-dicts.ts`);
    }
  }

  /**
   * Load an allowlist file (one word per line, lowercase, ignore comments/empty lines).
   */
  private async loadAllowlistFile(path: string): Promise<Set<string>> {
    const content = await readFile(path, 'utf-8');
    const words = new Set<string>();
    
    for (const line of content.split('\n')) {
      const trimmed = line.trim().toLowerCase();
      // Skip empty lines and comments (lines starting with #)
      if (trimmed && !trimmed.startsWith('#')) {
        words.add(trimmed);
      }
    }
    
    return words;
  }

  /**
   * Normalize a token for spellchecking (lowercase, trim, strip leading/trailing punctuation).
   */
  normalizeToken(token: string): string {
    return token.trim().toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
  }

  /**
   * Check if a token should be ignored for spellchecking.
   */
  shouldIgnoreToken(token: string): boolean {
    const t = token.trim();
    
    // Skip short tokens (<= 3 chars)
    if (t.length <= 3) return true;
    
    // Skip ALLCAPS short acronyms (GST, RDS, etc.)
    if (t.length <= 5 && /^[A-Z]+$/.test(t)) return true;
    
    // Skip alphanumeric codes / pack sizes (12x500g, 500ml, A1, #1234)
    if (/^[\d#A-Za-z]+$/.test(t) && /\d/.test(t)) {
      // But allow if it's mostly letters (like "A1" might be a product code)
      const letterCount = (t.match(/[A-Za-z]/g) || []).length;
      if (letterCount / t.length < 0.5) return true;
    }
    
    // Skip tokens with low letter ratio (< 70% letters)
    const letterCount = (t.match(/[A-Za-z]/g) || []).length;
    if (letterCount / t.length < 0.7) return true;
    
    // Skip tokens that are mostly punctuation/symbols
    const symbolCount = (t.match(/[^\w\s]/g) || []).length;
    if (symbolCount / t.length > 0.3) return true;
    
    return false;
  }

  /**
   * Check if a word is correct (in allowlist or dictionary).
   * Returns true in disabled mode (if dictionaries failed to load).
   * MUST NOT trigger initialization - must be called after initialize() at boot.
   */
  isCorrect(word: string): boolean {
    // No lazy initialization - must be called after initialize()
    if (this.status === 'uninitialized') {
      // Should never happen if initialize() was called at boot
      return true; // Safe fallback
    }

    if (this.status === 'disabled' || this.spellEngines.size === 0) {
      return true; // Disabled mode - no typo warnings
    }

    const normalized = this.normalizeToken(word);
    if (!normalized) return true;

    // Check allowlists first
    const allowlistValues = Array.from(this.allowlists.values());
    for (let i = 0; i < allowlistValues.length; i++) {
      const allowlist = allowlistValues[i];
      if (allowlist.has(normalized)) {
        return true;
      }
    }

    // Check against all loaded dictionaries
    const spellValues = Array.from(this.spellEngines.values());
    for (let i = 0; i < spellValues.length; i++) {
      const spell = spellValues[i];
      if (spell.correct(normalized)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get spelling suggestions for a word.
   * Returns up to limit suggestions.
   * MUST NOT trigger initialization - must be called after initialize() at boot.
   */
  suggest(word: string, limit: number = 3): string[] {
    if (this.status !== 'ready' || this.spellEngines.size === 0) {
      return [];
    }

    const normalized = this.normalizeToken(word);
    if (!normalized) return [];

    // Get suggestions from all dictionaries and merge
    const allSuggestions = new Set<string>();
    const spellValues = Array.from(this.spellEngines.values());
    for (let i = 0; i < spellValues.length; i++) {
      const spell = spellValues[i];
      const suggestions = spell.suggest(normalized);
      for (const suggestion of suggestions.slice(0, limit)) {
        allSuggestions.add(suggestion);
      }
    }

    return Array.from(allSuggestions).slice(0, limit);
  }
}

// Export singleton instance
export const spellCheckService = SpellCheckService.getInstance();

