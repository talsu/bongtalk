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

				self.init(function (err){
					if (tools.isFunction(callback)) callback(err);
				});
			}
			else {
				debug('Mongodb connection Error - ' + err);
				if (tools.isFunction(callback)) callback(err);
			}
		});
	};

	Database.prototype.init = function (callback) {
		var self = this;
		self.getUser('admin', function (err, result){
			if (err){
				if (tools.isFunction(callback)) { callback(err); }
				return;
			}

			if (!result) {
				debug('Create admin user');
				self.addUser('admin', 'Administrator', '21232f297a57a5a743894a0e4a801fc3', 'admin', function (err, result){
					if (err){
						if (tools.isFunction(callback)) { callback(err); }
						return;
					}

					if (tools.isFunction(callback)) callback();

				}); // default admin password is 'admin'
			}
			else {
				if (tools.isFunction(callback)) callback();
			}
		});

	};

	// User
	Database.prototype.addUser = function (userId, userName, password, role, callback) {
		var self = this;
		var user = {
			id : userId,
			name : userName,
			password : password,
			role : role,
			sessions : []
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

	Database.prototype.getAllUser = function (callback) {
		this.db.collection('User').find().toArray(callback);
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

	Database.prototype.removeUser = function (userId, callback) {
		var self = this;
		self.getUser(userId, function (err, result){
			if (err) { callback(err, result); return; }

			result.sessions = result.sessions || [];
			async.each(result.sessions, function (oSessionId, callback){
				var sessionId = oSessionId.toString();
				self.removeUserFromSession(userId, sessionId, function (err, result){
					if (err) callback(err);
					else callback();
				});
			}, function (err) {
				if (err) { callback(err, result); return; }
				self.db.collection('User').remove({id:userId}, callback);
			});
		});
	};

	// Session
	Database.prototype.addSession = function (name, type, users, callback) {
		var self = this;
		var session = {
			name:name,
			type:type,
			users:[],
			creationTime:Date.now()
		};
		self.db.collection('Session').insert(session, function (err, result){
			if (err || !users || !Array.isArray(users) || users.length == 0) {
				callback(err, result);
				return;
			}
			var sessionId = result.ops[0]._id.toString();
			async.each(users, function (userId, callback){
				self.addUserToSession(userId, sessionId, function (err, result){
					if (err) callback(err);
					else callback();
				});
			}, function (err){
				if (err) callback(err, null);
				else self.getSession(sessionId, callback);
			});
		});
	};

	Database.prototype.removeSession = function (sessionId, callback) {
		var self = this;
		debug('Start remove session :' + sessionId);
		if (!ObjectID.isValid(sessionId)) {callback('Invalid sessionID.', null); return;}
		var oSessionId = new ObjectID(sessionId);

		self.getSession(sessionId, function (err, result){
			if (err) { callback(err, result); return; }
			if (!result) { callback('Not exist session : ' + sessionId, null); return; }
			debug('[remove session] session has ' + result.users + ' users.');
			result.users = result.users || [];
			async.each(result.users, function (userId, callback){
				debug('[remove session] Remove user from session userId :' + userId);
				self.removeUserFromSession(userId, sessionId, function (err, result){
					debug('[remove session] Remove user "'+userId+'" from session ' + sessionId);
					if (err) callback(err);
					else callback();
				});
			}, function (err){
				if (err) { callback(err, result); return; }
				debug('[remove session] Remove session "'+oSessionId+'"');
				self.db.collection('Session').remove({_id:oSessionId}, callback);
			});

			self.db.collection('Telegram').remove({sessionId:oSessionId}, function(){});
		});
	};

	Database.prototype.getSession = function (sessionId, callback) {
		var self = this;
		if (!ObjectID.isValid(sessionId)) {callback('Invalid sessionID.', null); return;}

		self.db.collection('Session').findOne({_id:new ObjectID(sessionId)}, function (err, session){
			if (err || !session) { callback(err, session); return; }

			self.getTelegrams(session._id.toString(), 0, 1, function (err, telegrams){
				session.telegrams = telegrams || [];
				callback(null, session);
			});
		});
	};

	Database.prototype.getSessionUsers = function (sessionId, callback) {
		var self = this;
		if (!ObjectID.isValid(sessionId)) {callback('Invalid sessionID.', null); return;}

		self.db.collection('Session').findOne({_id:new ObjectID(sessionId)}, function (err, session){
			if (err || !session) { callback(err, session); return; }

			async.map(session.users, function (userId, callback){
				self.getUser(userId, function (err, user) {
					if (err) {callback(err, null); return;}
					callback(null, {
						id:user.id,
						name:user.name,
						role:user.role
					});
				});
			}, callback);
		});
	};

	Database.prototype.getAllSession = function (callback) {
		this.db.collection('Session').find().toArray(callback);
	};

	Database.prototype.addUserToSession = function (userId, sessionId, callback) {
		var self = this;
		if (!ObjectID.isValid(sessionId)) {callback('Invalid sessionID.', null); return;}

		var oSessionId = new ObjectID(sessionId);
		self.db.collection('Session').update({_id:oSessionId}, {$addToSet:{users:userId}}, function (err, result){
			if (err) {
				callback(err, result);
				return;
			}
			self.db.collection('User').update({id:userId}, {$addToSet:{sessions:oSessionId}}, function (err, result){
				if (err) {
					// Rollback
					self.db.collection('Session').update({_id:oSessionId}, {$pull:{users:userId}}, function(){});
				}

				callback(err, result);
			});
		});
	};

	Database.prototype.removeUserFromSession = function (userId, sessionId, callback) {
		var self = this;
		if (!ObjectID.isValid(sessionId)) {callback('Invalid sessionID.', null); return;}

		var oSessionId = new ObjectID(sessionId);
		self.db.collection('Session').update({_id:oSessionId}, {$pull:{users:userId}}, function (err, result){
			if (err) {
				callback(err, result);
				return;
			}
			self.db.collection('User').update({id:userId}, {$pull:{sessions:oSessionId}}, callback);
		});
	};

	Database.prototype.getUserSessions = function (userId, callback) {
		var self = this;

		self.getUser(userId, function (err, result){
			if (err) { callback(err, null); return; }
			if (result && result.sessions && result.sessions.length > 0) {
				self.db.collection('Session').find({_id:{$in:result.sessions}}).toArray(function (err, sessions){
					if (err) { callback(err, null); return; }
					async.map(sessions, function (session, callback){
						self.getTelegrams(session._id.toString(), 0, 1, function (err, telegrams){
							session.telegrams = telegrams || [];
							callback(null, session);
						});
					}, callback);
				});
			} else {
				callback(err, []);
			}
		});
	};

	Database.prototype.getPublicSessions = function (callback) {
		var self = this;
		self.db.collection('Session').find({type:'public', $where:'this.users.length>0'}).toArray(callback);
	};

	// Telegram
	Database.prototype.addTelegram = function (userId, sessionId, userName, type, subType, data, callback) {
		if (!ObjectID.isValid(sessionId)) {callback('Invalid sessionID.', null); return;}

		var self = this;
		var oSessionId = new ObjectID(sessionId);

		var telegram = {
			sessionId: oSessionId,
			userId: userId,
			userName: userName,
			time: Date.now(),
			type: type,
			subType: subType,
			data: data
		};
		self.db.collection('Telegram').insert(telegram, callback);
	};

	Database.prototype.getTelegrams = function (sessionId, ltTime, count, callback){
		debug('getTelegrams - ltTime:' + ltTime + ' count:' + count);
		if (!ObjectID.isValid(sessionId)) {callback('Invalid sessionID.', null); return;}

		var self = this;
		var oSessionId = new ObjectID(sessionId);

		if (ltTime > 0 && count <= 0) {
			self.db.collection('Telegram').find({
				sessionId:oSessionId,
				time:{ $lt: ltTime }
			}).sort({time:-1}).toArray(callback);
		} else if (ltTime <= 0 && count > 0){
			getEndTelegrams(function (err, gteTelegram){
				if (err) { callback(err, gteTelegram); return; }
				var query = {sessionId:oSessionId};
				if (gteTelegram) query.time = { $gte: gteTelegram.time };
				self.db.collection('Telegram').find(query).sort({time:-1}).toArray(callback);
			});
		} else if (ltTime > 0 && count > 0){
			getEndTelegrams(function (err, gteTelegram){
				if (err) { callback(err, gteTelegram); return; }
				var query = {sessionId:oSessionId, time:{ $lt: ltTime }};
				if (gteTelegram) query.time['$gte'] = gteTelegram.time;
				self.db.collection('Telegram').find(query).sort({time:-1}).toArray(callback);
			});
		} else {
			self.db.collection('Telegram').find({sessionId:oSessionId}).sort({time:-1}).toArray(callback);
		}

		function getEndTelegrams(callback){
			var findQuery = {sessionId:oSessionId, type:'talk'};
			if (ltTime > 0) findQuery['time'] = {$lt:ltTime};

			debug('getEndTelegrams - ltTime:' + ltTime + ' count:' + count);
			self.db.collection('Telegram')
			.find(findQuery)
			.sort({time:-1})
			.skip(count - 1)
			.nextObject(function (err, telegram){
				if (err) { callback(err, telegram); return; }
				if (telegram) {
					debug('getEndTelegrams - end time:' + telegram.time);
					callback(err, telegram);
				}
				else {
					self.db.collection('Telegram')
					.find({sessionId:oSessionId})
					.sort({time:1})
					.nextObject(callback);
				}
			});
		}

	};



	Database.prototype.getTelegramsWithSkipTake = function (sessionId, skip, take, callback){
		debug('getTelegrams - skip:' + skip + ' take:' + take);

		if (!ObjectID.isValid(sessionId)) {callback('Invalid sessionID.', null); return;}

		var self = this;
		var oSessionId = new ObjectID(sessionId);

		if (skip > 0 && take <= 0) {
			self.getTalkTelegramByIndex(oSessionId, skip, function (err, ltTelgram){
				if (err) { callback(err, lteTelgram); return; }

				debug({ $lt: lteTelgram.time });

				self.db.collection('Telegram').find({
					sessionId:oSessionId,
					time:{ $lt: lteTelgram.time }
				}).sort({time:-1}).toArray(callback);
			});

		} else if (skip <= 0 && take > 0){
			self.getTalkTelegramByIndex(oSessionId, skip + take -1, function (err, gteTelegram){
				if (err) { callback(err, gtTelegram); return; }

				debug({ $gte: gteTelegram.time });

				self.db.collection('Telegram').find({
					sessionId:oSessionId,
					time:{ $gte: gteTelegram.time }
				}).sort({time:-1}).toArray(callback);
			});
		} else if (skip > 0 && take > 0){
			self.getTalkTelegramByIndex(oSessionId, skip, function (err, ltTelgram){
				if (err) { callback(err, lteTelgram); return; }
				self.getTalkTelegramByIndex(oSessionId, skip + take -1, function (err, gteTelegram){
					if (err) { callback(err, gtTelegram); return; }

					debug({ $gte: gteTelegram.time, $lt: lteTelgram.time });

					self.db.collection('Telegram').find({
						sessionId:oSessionId,
						time:{ $gte: gteTelegram.time, $lt: lteTelgram.time }
					}).sort({time:-1}).toArray(callback);
				});
			});
		}
		else {
			debug("with no option");
			self.db.collection('Telegram').find({sessionId:oSessionId}).sort({time:-1}).toArray(callback);
		}
	};

	Database.prototype.getTalkTelegramByIndex = function (oSessionId, index, callback) {
		var self = this;

		self.db.collection('Telegram')
		.find({sessionId:oSessionId, type:'talk'})
		.sort({time:-1})
		.skip(index)
		.nextObject(function (err, telegram){
			if (err) { callback(err, telegram); return; }
			if (telegram) {
				callback(err, telegram);
			}
			else {
				self.db.collection('Telegram')
				.find({sessionId:oSessionId})
				.sort({time:1})
				.nextObject(callback);
			}
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
