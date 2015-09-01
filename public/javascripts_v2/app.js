'use strict';

/* App Module */

angular.module('bongtalkApp', [
	'ngRoute',
	'bongtalk.controllers'
])
.config(['$routeProvider',
	function($routeProvider) {
		$routeProvider
			.when('/', { templateUrl: 'partials_v2/main.html', controller: 'MainController' })
			.otherwise({ redirectTo: '/'});
	}]);


angular.module('bongtalkSessionApp', [
	'ngRoute',
	'bongtalk.controllers'
])
.config(['$routeProvider',
	function($routeProvider) {
		$routeProvider
			.when('/', { templateUrl: 'partials_v2/session.html', controller: 'SessionController' })
			.otherwise({ redirectTo: '/'});
	}]);