const architectureAliases = new Map([
    ['x64', 'x64'],
    ['arm', 'arm64'],
    ['arm64', 'arm64'],
    ['x86', 'ia32'],
    ['ia32', 'ia32'],
]);

const architectureDefinitions = {
    x64: { arch: 'x64', dotnetRuntime: 'win-x64', electronBuilderFlag: '--x64' },
    arm64: { arch: 'arm64', dotnetRuntime: 'win-arm64', electronBuilderFlag: '--arm64' },
    ia32: { arch: 'ia32', dotnetRuntime: 'win-x86', electronBuilderFlag: '--ia32' },
};

function normalizeWindowsArchitecture(value) {
    const normalized = architectureAliases.get(String(value).trim().replace(/^--/, '').toLowerCase());
    if (!normalized) {
        throw new Error(`Unsupported Windows architecture: ${value}. Use x64, arm/arm64, or x86/ia32.`);
    }
    return architectureDefinitions[normalized];
}

function parseWindowsArchitectureArguments(args, defaultArchitecture = process.arch) {
    const architectures = [];
    const passthroughArguments = [];

    const addArchitecture = value => {
        const architecture = normalizeWindowsArchitecture(value);
        if (!architectures.some(candidate => candidate.arch === architecture.arch)) {
            architectures.push(architecture);
        }
    };

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        const directArchitecture = architectureAliases.get(argument.replace(/^--/, '').toLowerCase());
        if (directArchitecture) {
            addArchitecture(directArchitecture);
            continue;
        }

        if (argument === '--arch') {
            if (index + 1 >= args.length) throw new Error('Missing value after --arch.');
            addArchitecture(args[index + 1]);
            index += 1;
            continue;
        }

        if (argument.startsWith('--arch=')) {
            addArchitecture(argument.slice('--arch='.length));
            continue;
        }

        passthroughArguments.push(argument);
    }

    if (architectures.length === 0) addArchitecture(defaultArchitecture);
    return { architectures, passthroughArguments };
}

module.exports = {
    normalizeWindowsArchitecture,
    parseWindowsArchitectureArguments,
};
