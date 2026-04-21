class MissingEnvironmentVariableException extends Error {
    variableName;

    constructor(variableName) {
        super(`The required environment variable '${variableName}' is missing`);

        this.variableName = variableName;
    }
}

export function hasConfigVariable(name) {
    const value = process.env[name];
    return typeof value === "string" && value.trim() !== "";
}

export function getConfigVariable(name, defaultValue = null) {
    if (!hasConfigVariable(name)) {
        if (defaultValue == null) {
            throw new MissingEnvironmentVariableException(name)
        }

        return defaultValue;
    }

    return process.env[name].trim();
}

export function getOptionalConfigVariable(name, defaultValue = null) {
    return hasConfigVariable(name) ? process.env[name].trim() : defaultValue;
}
