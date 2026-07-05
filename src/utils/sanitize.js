const sanitize = (input) => {
    if (typeof input !== "string") return input;
    return input.replace(/[^ -~Ѐ-ӿ]/g, "").trim().slice(0, 10000);
};

const validateUsername = (username) => {
    if (!username || typeof username !== "string") return false;
    return /^[a-zA-Z0-9_.-]{1,30}$/.test(username);
};

const validatePassword = (password) => {
    if (!password || typeof password !== "string") return false;
    return password.length >= 8 && password.length <= 100;
};

module.exports = { sanitize, validateUsername, validatePassword };
