var format = require('util').format;    
var debug = require('debug')('bongtalk:Database');
var MongoClient = require('mongodb').MongoClient;
var ObjectID = require('mongodb').ObjectID;
var async = require('async');
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

	// User
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

	// Session
	Database.prototype.addSession = function (name, type, callback) {
		var self = this;
		var session = {
			name:name,
			type:type,
			users:[],
			creationTime:Date.now()
		};
		self.db.collection('Session').insert(session, callback);
	};

	Database.prototype.getSession = function (sessionId, callback) {
		var self = this;
		self.db.collection('Session').findOne({_id:new ObjectID(sessionId)}, callback);
	};

	Database.prototype.addUserToSession = function (userId, sessionId, callback) {
		var self = this;
		var oSessionId = new ObjectID(sessionId);
		self.db.collection('Session').update({_id:oSessionId}, {$push:{users:userId}}, function (err, result){
			if (err) {
				callback(err, result);
				return;
			}

			self.db.collection('User').update({id:userId}, {$push:{sessions:oSessionId}}, function (err, result){
				if (err) {
					// Rollback
					self.db.collection('Session').update({_id:oSessionId}, {$pull:{users:userId}}, function(){});
				}

				callback(err, result);
			});
		});
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