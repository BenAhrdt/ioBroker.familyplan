const { tests } = require('@iobroker/testing');
tests.packageFiles(__dirname + '/..', { additionalFiles: ['admin/jsonConfig.json', 'admin/tab.html'] });
