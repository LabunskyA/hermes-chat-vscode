import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface HermesProfile {
    name: string;
    description: string;
    provider: string;
    model: string;
    isDefault: boolean;
}

export interface HermesProfileSettings {
    provider: string;
    model: string;
    apiKeyConfigured: boolean;
}

export class ProfileStore {
    constructor(private readonly root = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')) {}

    list(): HermesProfile[] {
        const profiles = [this.readProfile('default', this.root, true)];
        const profilesDir = path.join(this.root, 'profiles');
        if (!fs.existsSync(profilesDir)) return profiles;
        for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory() && this.isValidName(entry.name)) {
                profiles.push(this.readProfile(entry.name, path.join(profilesDir, entry.name), false));
            }
        }
        return profiles;
    }

    isValidName(name: string): boolean {
        return /^[a-z][a-z0-9-]{1,31}$/.test(name) && !name.endsWith('-');
    }

    getSettings(name: string): HermesProfileSettings {
        const home = this.profileHome(name);
        const config = this.readYaml(path.join(home, 'config.yaml'));
        const model = (config.model ?? {}) as Record<string, unknown>;
        const envPath = path.join(home, '.env');
        const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
        const provider = typeof model.provider === 'string' ? model.provider : 'auto';
        return {
            provider,
            model: typeof model.default === 'string' ? model.default : (typeof model.model === 'string' ? model.model : ''),
            apiKeyConfigured: new RegExp(`^${this.providerEnvKey(provider)}=.+$`, 'm').test(env),
        };
    }

    saveSettings(name: string, provider: string, modelName: string, apiKey?: string): HermesProfileSettings {
        const home = this.profileHome(name);
        const configPath = path.join(home, 'config.yaml');
        const config = this.readYaml(configPath);
        const model = (config.model ?? {}) as Record<string, unknown>;
        model.provider = provider.trim() || 'auto';
        if (modelName.trim()) model.default = modelName.trim();
        else delete model.default;
        config.model = model;
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: 100 }));

        if (apiKey?.trim()) {
            const envPath = path.join(home, '.env');
            let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
            const keyName = this.providerEnvKey(provider);
            const line = `${keyName}=${apiKey.trim()}`;
            const pattern = new RegExp(`^${keyName}=.*$`, 'm');
            env = pattern.test(env) ? env.replace(pattern, line) : `${env}${env && !env.endsWith('\n') ? '\n' : ''}${line}\n`;
            fs.writeFileSync(envPath, env, { mode: 0o600 });
        }

        return this.getSettings(name);
    }

    private profileHome(name: string): string {
        return name === 'default' ? this.root : path.join(this.root, 'profiles', name);
    }

    private providerEnvKey(provider: string): string {
        const known: Record<string, string> = {
            anthropic: 'ANTHROPIC_API_KEY',
            gemini: 'GEMINI_API_KEY',
            openai: 'OPENAI_API_KEY',
            'openai-codex': 'OPENAI_API_KEY',
            'openai-api': 'OPENAI_API_KEY',
            openrouter: 'OPENROUTER_API_KEY',
        };
        return known[provider] || `${provider.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}_API_KEY`;
    }

    private readProfile(name: string, home: string, isDefault: boolean): HermesProfile {
        const config = this.readYaml(path.join(home, 'config.yaml'));
        const metadata = this.readYaml(path.join(home, 'profile.yaml'));
        const model = (config.model ?? {}) as Record<string, unknown>;
        return {
            name,
            isDefault,
            description: typeof metadata.description === 'string' ? metadata.description : (isDefault ? 'Default Hermes agent' : ''),
            provider: typeof model.provider === 'string' ? model.provider : 'auto',
            model: typeof model.default === 'string' ? model.default : (typeof model.model === 'string' ? model.model : ''),
        };
    }

    private readYaml(filePath: string): Record<string, unknown> {
        try {
            if (!fs.existsSync(filePath)) return {};
            return (yaml.load(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>) || {};
        } catch {
            return {};
        }
    }
}
