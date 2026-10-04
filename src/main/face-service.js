'use strict';
const { SemanticSearch } = require('./semantic-search');
class FaceService extends SemanticSearch {
  constructor(dbPath, facePath) {
    super(dbPath, facePath, {
      workerFile: 'face-worker.js',
      objectPayload: true,
      preserveProgress: [
        'groups',
        'photos',
        'rename',
        'merge',
        'move',
        'regroup',
        'settings',
        'saveSettings',
      ],
      // 只读查询：索引进行中允许并发执行，让「人物」页实时显示已识别结果。
      // 不包含写操作（rename / merge / move / regroup），避免与索引写入争锁。
      concurrentReads: ['groups', 'photos', 'settings'],
      label: 'People index',
      operations: [
        'status',
        'install',
        'index',
        'groups',
        'photos',
        'rename',
        'merge',
        'move',
        'regroup',
        'settings',
        'saveSettings',
      ],
    });
  }
}
module.exports = { FaceService };
