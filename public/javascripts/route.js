'use strict';

define(['controllers'], function (app){
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