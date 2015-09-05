var format = require('util').format;    
var debug = require('debug')('bongtalk:Database');
var MongoClient = require('mongodb').MongoClient;
var tools = require('./tools');

module.exports = (function() {
	function Database(mongodbUrl) {
		var self = this;
		self.mongodbUrl = mongodbUrl;
	}

	Database.prototype.connect = function (callback) {
		var self = this;

		debug('Try Mongodb connect ... (' + self.mongodbUrl + ')');

		MongoClient.connect(self.mongodbUrl, function (err, db){
			if (!err) {
				self.db = db;
				debug('Mongodb connected.');
			}
			else {
				debug('Mongodb connection Error - ' + err);
			}

			if (tools.isFunction(callback)) callback(err);
		});
	};

	Database.prototype.addUser = function (userId, password, callback) {
		var self = this;		
		var user = {
			id : userId,
			name : userId,
			password : password
		};			
		self.db.collection('User').insert(user, callback);
	};

	Database.prototype.getUser = function (userId, callback) {
		var self = this;
		if (typeof userId != 'string'){
			var err = 'Bad userId : ' + userId;
			debug(err);
			callback(err);
		}
		else {
			self.db.collection('User').findOne({id:userId}, callback);
		}
	};

	Database.prototype.setUser = function (userId, data, callback) {
		var self = this;
		if (typeof userId != 'string'){
			var err = 'Bad userId : ' + userId;
			debug(err);
			callback(err);
		} else {
			self.db.collection('User').updateOne({id:userId}, {$set:data}, callback);
		}
	};

	// Database.prototype.AddTelegram = function (telegram, callback) {
	// 	var self = this;
	// 	if (!telegram || !telegram.type || !telegram.data) {
	// 		debug('Bad telegram format.');
	// 	}
	// 	else
	// 	{
	// 		var type = telegram.type;
	// 		delete telegram.type;
	// 		self.db.collection(type).insert(telegram, function (err, docs){
	// 			if (err) {
	// 				debug('collection['+type+'] insert Error - ' + err);
	// 			}

	// 			if (tools.isFunction(callback)) callback(err, docs);
	// 		});
	// 	}
	// };

	return Database;
})();