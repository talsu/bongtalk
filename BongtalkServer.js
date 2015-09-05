var http = require('http');
var path = require('path');
var util = require('util');
var crypto = require('crypto');
var debug = require('debug')('bongtalk');
var Guid = require('guid');
var async = require('async');
var express = require('express');
var logger = require('morgan');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var methodOverride = require('method-override');
var errorhandler = require('errorhandler');
var redis = require("redis");
var jwt = require('jsonwebtoken');

var tools = require('./tools');
var RedisDatabase = require('./RedisDatabase').RedisDatabase;
var MongoDatabase = require('./MongoDatabase');

var QufoxServer = require('qufox').QufoxServer;

var secretString = 'bongtalkSecret';

exports.BongtalkServer = (function(){
	function BongtalkServer(option){
		this.option = option;
		this.servicePort = process.env.PORT || option.servicePort;
		this.redisUrl = option.redisUrl;
		this.cookieParser = cookieParser(secretString);
		this.database = new RedisDatabase(tools.createRedisClient(this.redisUrl), Guid.create().value);
		this.mDatabase = new MongoDatabase('mongodb://127.0.0.1:27017/bongtalk');	
	}

	BongtalkServer.prototype.run = function(){
		var self = this;

		var listenTarget = this.servicePort;

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
		app.get('/isAlive', function (req, res){res.send();});
		app.get('/p', function (req, res){ res.render('popup.html'); });

		app.get('/getAllChannel', function (req, res) {
			tools.pLog('getAllChannel');
			self.database.getAllChannelsKey(function(err, keys){					
				res.send({err:err, result:keys})
			});			
		});

		app.post('/addUserToChannel', function (req, res){				
			var channelId = req.body.channelId;
			var name = req.body.userName || ('user' + Math.floor((Math.random() * 1000) + 100));
			var userId = req.body.userId || Guid.create().value;
			tools.pLog('addUserToChannel -' + ' (channelId: ' + channelId + ')');

			self.database.addUserToChannel(channelId, userId, name, function(err){
				self.database.getUserFromChannel(channelId, userId, function(err, user){
					res.send({err:err, result:user});					
				});
			});
		});

		app.post('/joinChannel', function (req, res){				
			var channelId = req.body.channelId;
			// var userId = req.body.userId;

			async.parallel({
				users: function(callback){ self.database.getUsersFromChannel(channelId, callback);	},
				talks: function(callback){ self.database.getTalkHistory(channelId, callback); }
			},
			function (err, result) {
				if (!err){
					result.connectionId = Guid.create().value;											
					tools.pLog('joinChannel -'+ ' (channelId: ' + channelId + ')');
				}
				res.send({err:err, result:result})
			});
		})

		app.post('/leaveChannel' , function (req, res){				
			var connectionId = req.body.connectionId;				
			tools.pLog('leaveChannel -' + ' (connectionId: ' + connectionId + ')');
			res.send({err:null, result:'done'});
		});

		app.post('/getTalkHistory', function (req, res){
			var channelId = req.body.channelId;
			tools.pLog('getTalkHistory -' + ' (channelId: ' + channelId + ')');
			
			self.database.getTalkHistory(channelId, function(err, result){
				res.send({err:err, result:result});
			});
		});

		app.post('/clearTalkHistory', function (req, res){
			var channelId = req.body.channelId;
			tools.pLog('clearTalkHistory -' + ' (channelId: ' + channelId + ')');

			self.database.clearTalkHistory(channelId, function(err, result){
				res.send({err:err, result:result});
			});
		});

		app.post('/clearUser', function (req, res){
			var channelId = req.body.channelId;
			tools.pLog('clearTalkHistory -' + ' (channelId: ' + channelId + ')');

			self.database.clearAllUserInChannel(channelId, function(err, result){
				res.send({err:err, result:result});
			});
		});

		app.post('/getUsersFromChannel', function (req, res){
			var channelId = req.channelId;
			tools.pLog('getUsersFromChannel -' + ' (channelId: ' + channelId + ')');
			
			self.database.getUsersFromChannel(channelId, function(err, result){
				res.send({err:err, result:result});
			});
		});

		app.post('/getUserFromChannel', function (req, res){				
			var channelId = req.body.channelId;
			var userId = req.body.userId;
			tools.pLog('getUserFromChannel -' + ' (channelId: ' + channelId + ')' + ' (userId: ' + userId + ')');
			
			if (!channelId){
				res.send({err:'bad channelId', result:null});				
			}
			else if (!userId){
				res.send({err:'bad userId', result:null});
			}
			else {
				self.database.getUserFromChannel(channelId, userId, function(err, user){
					res.send({err:err, result:user});	
				});	
			}
		});

		app.post('/addNewTalk', function (req, res){
			var channelId = req.body.channelId;
			var talk = {
				id: Guid.create().value,					
				time : new Date(),
				message : req.body.message,
				userId : req.body.userId
			}
			tools.pLog('addNewTalk -' + ' (channelId: ' + channelId + ')' + ' (userId: ' + talk.userId + ')');
			
			self.database.addTalkHistory(channelId, talk, function(err, result){
				res.send({err:err, result:talk});				
			});
		});

		app.post('/updateUser', function (req, res){
			var channelId = req.body.channelId;
			var userId = req.body.userId;
			var propertyName = req.body.propertyName;
			var data = req.body.data;

			if (channelId && userId && propertyName){
				self.database.setUserProperty(channelId, userId, propertyName, data, function (err, result){
					if (err){
						res.send({err:err, result:null});
					}
					else{
						var result = {
							userId:userId,
							propertyName:propertyName,
							data:data
						};
						res.send({err:err, result:result});						
					}
				});
			};
		});

		

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
						self.mDatabase.addUser(userId, hashedPassword, function (err, result){
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
						var token = jwt.sign(user.id, app.get('bongtalkSecret'), {
							expiresInMinutes: 1440 // expires in 24 hours
						});

						// remove password field.
						delete user.password;

						// return the information including token as JSON
						res.json({err: null, result: {token:token, user:user}});
						debug('Sign in - ' + userId);
					}
				}
			});
		});

		// route middleware to verify a token
		apiRoutes.use(function(req, res, next) {

			// check header or url parameters or post parameters for token
			var token = req.body.token || req.query.token || req.headers['x-access-token'];
			// decode token
			if (token) {
				// verifies secret and checks exp
				jwt.verify(token, app.get('bongtalkSecret'), function(err, decoded) {  
					if (err || !decoded) {
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

		apiRoutes.get('/users/:id', function (req, res){
			var userId = req.params.id;
			self.mDatabase.getUser(userId, function (err, result) {
				if (err) debug(err);
				if (result) delete result.password;
				res.json({err:err, result:result});
			});
		});

		apiRoutes.put('/users/:id', function (req, res){
			var userId = req.params.id;
			var data = req.body;
			for (var property in data) {
				debug('Set ' + userId + ' - '+property + " : " + data[property]);
			}
			self.mDatabase.setUser(userId, data, function (err, result){
				res.json({err:err, result:result});
			});
		});

		// // mongodb
		// apiRoutes.post('/addUser', function (req, res){
		// 	var userName = req.body.userName;
		// 	self.mDatabase.addUser(userName, resBind(res));
		// });

		// apiRoutes.post('/getUser', function (req, res){
		// 	var userId = req.body.userId;
		// 	self.mDatabase.getUser(userId, resBind(res));
		// });

		// apiRoutes.post('/setUser', function (req, res){
		// 	var userId = req.body.userId;
		// 	var property = req.body.property;
		// 	var value = req.body.value;
		// 	self.mDatabase.setUser(userId, property, value, resBind(res));
		// });


		app.use('/api', apiRoutes);


		function resBind(res){
			return function (err, result) {
				if (err) debug(err);
				res.send({err:err, result:result});
			};
		}

		self.mDatabase.connect(function (err){
			if (err) {tools.pLog(err); return;}
			var server = http.createServer(app);
			server.listen(self.servicePort);

			listenTarget = server;
			var transports = self.option.websocket ? ['websocket', 'polling'] : ['polling'];

			new QufoxServer({
				listenTarget: listenTarget,
				socketOption: {transports:transports},
				redisUrl: self.redisUrl
			});
		});
	};


	return BongtalkServer;
})();