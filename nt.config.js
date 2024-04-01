// 获取当前环境变量
const env = process.env.NODE_ENV;
const tagHead = env === 'pro' ? 'release-online-' : 'release-test-';

module.exports = {
    tagHead,
    versionName: 'v',
};
