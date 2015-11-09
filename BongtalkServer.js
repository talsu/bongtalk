var http = require('http');
var crypto = require('crypto');
var debug = require('debug')('bongtalk');
var async = require('async');
var express = require('express');
var logger = require('morgan');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var methodOverride = require('method-override');
var errorhandler = require('errorhandler');
var jwt = require('jsonwebtoken');
var QufoxServer = require('qufox').QufoxServer;

var tools = require('./tools');
var MongoDatabase = require('./MongoDatabase');
var AvatarImage = require('./AvatarImage');
var Validator = require('./Validator');

exports.BongtalkServer = (function(){
	function BongtalkServer(option){
		this.option = option;
		this.servicePort = process.env.PORT || option.servicePort;
		this.redisUrl = option.redisUrl;
		this.cookieParser = cookieParser(option.secret);
		this.mDatabase = new MongoDatabase(option.mongodbUrl);
		this.avatarImage = new AvatarImage();
	}

	BongtalkServer.prototype.run = function(){
		var self = this;

		var validator = new Validator();

		var app = express();
		app.set('bongtalkSecret', self.option.secret);
		app.use(logger('dev'));
		app.use(express.static(__dirname + '/public'));
		app.set('views', __dirname + '/public');
		app.set("view options", {layout: false});
		app.use(bodyParser.urlencoded({ extended: false }));
		app.use(bodyParser.json());
		app.use(methodOverride());
		app.use(this.cookieParser);
		app.use(errorhandler());
		app.engine('html', require('ejs').renderFile);

		var apiRoutes = express.Router();

		apiRoutes.get('/', function (req, res) {
			res.json({ message: 'API' });
		});

		apiRoutes.get('/checkUserExist', function (req, res){
			var userId = req.query.userId;
			self.mDatabase.getUser(userId, function (err, result){
				if (err) {
					res.json({err: err, result: null});
				}
				else{
					res.json({err: null, result: result ? true : false});
				}
			});
		});

		apiRoutes.post('/signUp', function (req, res){
			var userId = req.body.userId;
			var password = req.body.password;
			if (typeof userId != 'string' ||
			userId.length < 4 ||
			userId.length > 20)	{
				res.json({err: 'Invalid user id.', result: null});
			}
			else if (typeof password != 'string' ||
			password.length < 4 ||
			password.length > 20){
				res.json({err: 'Invalid password.', result: null});
			}
			else {
				// check exist userId
				self.mDatabase.getUser(userId, function (err, result){
					if (!err && result) {
						res.json({err: 'Exist user id.', result: null});
					}
					else{
						var hashedPassword = crypto.createHash('md5').update(password).digest('hex');
						self.mDatabase.addUser(userId, userId ,hashedPassword, 'user', function (err, result){
							res.json({err:err, result:result});
							debug('Sign up - ' + userId);
						});
					}
				});
			}
		});

		apiRoutes.post('/signIn', function (req, res) {
			var userId = req.body.userId;
			var password = req.body.password;
			self.mDatabase.getUser(userId, function (err, user){
				if (err) throw err;

				if (!user) {
					res.json({ err: 'Authentication failed. User not found.', result: null });
				} else if (user) {

					var hashedPassword = crypto.createHash('md5').update(password).digest('hex');

					// check if password matches
					if (user.password != hashedPassword) {
						res.json({ err: 'Authentication failed. Wrong password.', result: null });
					} else {
						// if user is found and password is right
						// create a token
						var token = jwt.sign({userId:user.id}, app.get('bongtalkSecret'), {
							expiresInMinutes: 120 // expires in 24 hours
						});

						// remove password field.
						delete user.password;

						jwt.verify(token, app.get('bongtalkSecret'), function (err, decoded) {
							// return the information including token as JSON
							res.json({err: null, result: {token:token, tokenExpire:decoded.exp, user:user}});
							debug('Sign in - ' + userId);
						});
					}
				}
			});
		});

		apiRoutes.post('/signInByGuest', function (req, res) {
			var userName = req.body.userName;
			var userId = tools.randomString(10);
			var password = tools.randomString(10);

			self.mDatabase.getUser(userId, function (err, user){
				if (user){
					res.json({err:'user id alreay exists.', result: null});
				}
				else {
					var hashedPassword = crypto.createHash('md5').update(password).digest('hex');
					self.mDatabase.addUser(userId, userName, hashedPassword, 'guest', function (err, result){
						if (err){
							res.json({err:err, result:result});
						}
						else {
							self.mDatabase.getUser(userId, function (err, user){
								var token = jwt.sign({userId:userId}, app.get('bongtalkSecret'), {
									expiresInMinutes: 120 // expires in 24 hours
								});
								jwt.verify(token, app.get('bongtalkSecret'), function (err, decoded) {
									// return the information including token as JSON
									res.json({err: null, result: {token:token, tokenExpire:decoded.exp, user:user}});
									debug('Guest Sign in - ' + userId);
								});
							});
						}
					});
				}
			});
		});

		apiRoutes.get('/avatars/random', function (req, res) {
			self.avatarImage.getRandomAvatarUrl(resBind(res));
		});

		// Route middleware to verify a token.
		// After this apis are needs SignIn(authentication).
		apiRoutes.use(function(req, res, next) {

			// check header or url parameters or post parameters for token
			var token = req.body.token || req.query.token || req.headers['x-access-token'];
			if (!token && req.cookies.auth_token) {
				token = JSON.parse(req.cookies.auth_token).token;
			}
			// decode token
			if (token) {
				// verifies secret and checks exp
				jwt.verify(token, app.get('bongtalkSecret'), function(err, decoded) {
					if (err || !decoded || !decoded.userId) {
						return res.status(403).send({ err: 'Failed to authenticate token.', result: null });
					} else {
						// if everything is good, save to request for use in other routes
						req.decoded = decoded;
						next();
					}
				});
			} else {
				// if there is no token
				// return an error
				return res.status(403).send({err: 'No token provided.', result: null});
			}
		});

		// Set userId
		apiRoutes.use(function(req, res, next) {
			var userId = req.body.userId || req.query.userId || req.decoded.userId;
			req.userId = userId;
			next();
		});

		// Chage user password
		apiRoutes.post('/changePassword', function (req, res){
			var userId = req.userId;
			var currentPassword = req.body.currentPassword;
			var newPassword = req.body.newPassword;

			var newPasswordValidateResult = validator.validatePassword(newPassword);
			if (!newPasswordValidateResult.ok) {
				res.json({err:newPasswordValidateResult.comment || 'Empty', result:null});
				return;
			}

			self.mDatabase.getUser(userId, function (err, result){
				if (err) {
					res.json({err:err, result:result});
					return;
				}
				if (!result) {
					res.json({err:'Can not find user.', result:null});
					return;
				}

				var hashedCurrentPassword = crypto.createHash('md5').update(currentPassword).digest('hex');
				if (result.password != hashedCurrentPassword) {
					res.json({err:'Invalid current password.', result:null});
					return;
				}

				var hashedNewPassword = crypto.createHash('md5').update(newPassword).digest('hex');
				self.mDatabase.setUser(userId, {password:hashedNewPassword}, function (err, result){
					res.json({err:err, result:result});
					debug('Change password - ' + userId);
				});

			});
		});

		// Refresh auth token
		apiRoutes.get('/refreshToken', function (req, res){
			var token = jwt.sign(req.decoded, app.get('bongtalkSecret'), { expiresInMinutes: 120 }); // expires in 2 hours
			jwt.verify(token, app.get('bongtalkSecret'), function (err, decoded) {
				self.mDatabase.getUser(decoded.userId, function (err, result) {
					if (err || !result) {
						res.json({err: 'Can not find user - ' + decoded.userId, result: null});
						debug(err);
					}
					else {
						delete result.password;
						res.json({err: null, result: {token:token, tokenExpire:decoded.exp, user:result}});
						debug('Refresh token - ' + req.decoded.userId);
					}
				});

			});
		});

		// Get my info
		apiRoutes.get('/user', function (req, res){
			var userId = req.userId;
			self.mDatabase.getUser(userId, function (err, result) {
				if (err) debug(err);
				if (result) {
					delete result.password;
				}
				res.json({err:err, result:result});
			});
		});

		// Get user info
		apiRoutes.get('/users/:id', function (req, res){
			var userId = req.params.id || req.userId;
			self.mDatabase.getUser(userId, function (err, result) {
				if (err) debug(err);
				if (result) delete result.password;
				res.json({err:err, result:result});
			});
		});

		// Update user info
		apiRoutes.put('/users/:id', function (req, res){
			var userId = req.params.id;
			var data = req.body;
			for (var property in data) {
				if (property != 'password' && property != 'role')
				debug('Set ' + userId + ' - '+property + " : " + data[property]);
			}
			self.mDatabase.setUser(userId, data, resBind(res));
		});

		// Get user's joined session list
		apiRoutes.get('/users/:id/sessions', function (req, res){
			var userId = req.params.id || req.userId;
			self.mDatabase.getUserSessions(userId, resBind(res));
		});

		// Create session
		apiRoutes.post('/sessions', function (req, res){
			var name = req.body.name;
			var type = req.body.type;
			var users = req.body.users || [];

			var nameValidResult = validator.validateSessionName(name);
			if (!nameValidResult.ok) { res.json({err:nameValidResult.comment, result:null}); return; }
			var typeValidResult = validator.validateSessionType(type, users);
			if (!typeValidResult.ok) { res.json({err:typeValidResult.comment, result:null}); return; }

			// userId exists check.
			async.each(users, function (userId, callback) {
				self.mDatabase.getUser(userId, function (err, result){
					if (err) callback(err);
					else if (!result) callback('Can not find user : ' + userId);
					else callback();
				});
			}, function (err) {
				if (err) {
					res.json({err:err, result:null});
				}
				else{
					self.mDatabase.addSession(name, type, users, resBind(res));
				}
			});
		});

		// Get session
		apiRoutes.get('/sessions/:id', function (req, res){
			var userId = req.userId;
			var sessionId = req.params.id;
			self.mDatabase.getSession(sessionId, function (err, result){
				if (err || !result) {
					res.json({err: 'Can not find session - ' + sessionId, result: null});
					if (err) debug(err);
				} else if (result.users.indexOf(userId) == -1) {
					if (result.type != 'public') {
						err = 'Not in session. userId : ' + userId;
						debug(err);
						res.json({err:err, result:null});
					} else {
						self.mDatabase.addUserToSession(userId, sessionId, function (err, result) {
							if (err) {
								res.json({err:err, result:null});
							} else {
								self.mDatabase.getSession(sessionId, resBind(res));
							}
						});
					}
				}
				else {
					res.json({err:err, result:result});
				}
			});
		});

		// Get user
		apiRoutes.get('/sessions/:id/users', function (req, res){
			var userId = req.userId;
			var sessionId = req.params.id;
			self.mDatabase.getSessionUsers(sessionId, function (err, result){
				if (err || !result) {
					res.json({err: 'Can not find session - ' + sessionId, result: null});
					if (err) debug(err);
				} else if(result.filter(function (item){return item.id == userId;}).length === 0) {
					err = 'Not in session. userId : ' + userId;
					debug(err);
					res.json({err:err, result:null});
				} else {
					res.json({err:err, result:result});
				}
			});
		});

		// Get public session list.
		apiRoutes.get('/sessions/type/public', function (req, res){
			self.mDatabase.getPublicSessions(resBind(res));
		});

		// Join session.
		apiRoutes.post('/sessions/:id/users', function (req,res){
			var sessionId = req.params.id;
			var userId = req.userId;

			async.waterfall([
				function (callback) {
					self.mDatabase.getSession(sessionId, function (err, result) {
						if (err) callback(err, result);
						else if (!result) callback('Session is not exist.', null);
						else callback(null);
					});
				},
				function (callback) {
					self.mDatabase.getUser(userId, function (err, result) {
						if (err) callback(err, result);
						else if (!result) callback('User is not exist.', null);
						else callback(null);
					});
				},
				function (callback) {
					self.mDatabase.addUserToSession(userId, sessionId, function (err, result) {
						callback(err, result);
					});
				}
			], resBind(res));
		});

		// Leave session.
		apiRoutes.delete('/sessions/:id/users', function (req,res){
			var sessionId = req.params.id;
			var userId = req.userId;

			async.waterfall([
				function (callback) {
					self.mDatabase.getSession(sessionId, function (err, result) {
						if (err) callback(err, result);
						else if (!result) callback('Session is not exist.', null);
						else callback(null);
					});
				},
				function (callback) {
					self.mDatabase.getUser(userId, function (err, result) {
						if (err) callback(err, result);
						else if (!result) callback('User is not exist.', null);
						else callback(null);
					});
				},
				function (callback) {
					self.mDatabase.removeUserFromSession(userId, sessionId, function (err, result) {
						callback(err, result);
					});
				}
			], resBind(res));
		});

		// Add telegram.
		apiRoutes.post('/sessions/:id/telegrams', function (req,res){
			var sessionId = req.params.id;
			var userId = req.userId;
			var userName = req.body.userName;
			var type = req.body.type;
			var subType = req.body.subType;
			var data = req.body.data;

			async.waterfall([
				function (callback) {
					self.mDatabase.getSession(sessionId, function (err, result) {
						if (err) callback(err, result);
						else if (!result) callback('Session is not exist.', null);
						else if (!result.users || result.users.indexOf(userId) == -1) callback('User is not in session', null);
						else callback(null);
					});
				},
				// function (callback) {
				// 	self.mDatabase.getUser(userId, function (err, result) {
				// 		if (err) callback(err, result);
				// 		else if (!result) callback('User is not exist.', null);
				// 		else callback(null);
				// 	});
				// },
				function (callback) {
					self.mDatabase.addTelegram(userId, sessionId, userName, type, subType, data, function (err, result) {
						callback(err, result);
					});
				}
			], resBindforInsert(res));
		});

		// Get session telegrams.
		apiRoutes.get('/sessions/:id/telegrams', function (req,res){
			var sessionId = req.params.id;
			var userId = req.userId;
			var ltTime = req.query.ltTime;
			var count = req.query.count;

			async.waterfall([
				function (callback) {
					self.mDatabase.getSession(sessionId, function (err, result) {
						if (err) callback(err, result);
						else if (!result) callback('Session is not exist.', null);
						else if (!result.users || result.users.indexOf(userId) == -1) callback('User is not in session', null);
						else callback(null);
					});
				},
				// function (callback) {
				// 	self.mDatabase.getUser(userId, function (err, result) {
				// 		if (err) callback(err, result);
				// 		else if (!result) callback('User is not exist.', null);
				// 		else callback(null);
				// 	});
				// },
				function (callback) {
					self.mDatabase.getTelegrams(sessionId, ltTime, count, function (err, result) {
						callback(err, result);
					});
				}
			], resBind(res));
		});

		// Admin Role check.
		apiRoutes.use(function (req, res, next) {
			self.mDatabase.getUser(req.userId, function (err, result){
				if (err) {
					debug(err);
					return res.json({err:err, result:result});
				}
				else {
					if (result && result.role == 'admin') { // check admin role
						next();
					}
					else {
						return res.status(403).send({ err: 'Need admin user.', result: null });
					}
				}
			});
		});

		// Remove user.
		apiRoutes.delete('/admin/users/:id', function (req, res){
			var userId = req.params.id;
			self.mDatabase.removeUser(userId, resBind(res));
		});

		// Remove session.
		apiRoutes.delete('/admin/sessions/:id', function (req, res){
			var sessionId = req.params.id;
			self.mDatabase.removeSession(sessionId, resBind(res));
		});

		// Get all user list.
		apiRoutes.get('/admin/users', function (req, res){
			self.mDatabase.getAllUser(resBind(res));
		});

		// Get all session list.
		apiRoutes.get('/admin/sessions', function (req, res){
			self.mDatabase.getAllSession(resBind(res));
		});

		// Get session
		apiRoutes.get('/admin/sessions/:id', function (req, res){
			var sessionId = req.params.id;
			self.mDatabase.getSession(sessionId, resBind(res));
		});

		app.use('/api', apiRoutes);

		function resBind(res){
			return function (err, result) {
				if (err) debug(err);
				res.json({err:err, result:result});
			};
		}

		function resBindforInsert(res){
			return function (err, result) {
				if (err) {
					debug(err);
					res.json({err:err, result:result});
				} else if (result.result && result.ops && result.ops.length > 0) {
					res.json({err:null, result:result.ops[0]});
				}
				else {
					res.json({err:'result is empty', result:null});
				}
			};
		}

		self.mDatabase.connect(function (err){
			if (err) {console.error(err); process.exit(1); return;}
			var server = http.createServer(app);
			server.listen(self.servicePort);

			new QufoxServer({
				listenTarget: server,
				redisUrl: self.redisUrl
			});
		});
	};


	return BongtalkServer;
})();
