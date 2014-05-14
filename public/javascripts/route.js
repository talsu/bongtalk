'use strict';

define(['controllers', 'controls/talk', 'controls/list'], function (app){
	app.config(['$routeProvider', function($routeProvider){
		$routeProvider.
			when('/ch/:channelId', {
				templateUrl: 'partials/talk.html',
				controller: 'talkCtrl'
			}).
			otherwise({
				redirectTo: '/'
			});
	}]);
});