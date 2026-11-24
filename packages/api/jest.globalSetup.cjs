const { MongoBinary } = require('mongodb-memory-server');

/** Finish cold-cache downloads before workers enter timed MongoDB setup hooks. */
module.exports = async () => {
  await MongoBinary.getPath();
};
