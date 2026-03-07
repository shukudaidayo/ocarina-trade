import './lib/appkit'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router'
import App from './app'
import Home from './pages/home'
import Create from './pages/create'
import Swap from './pages/swap'
import Offers from './pages/offers'
import './style.css'

const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'create', element: <Create /> },
      { path: 'swap/:chainId/:txHash', element: <Swap /> },
      { path: 'offers', element: <Offers /> },
    ],
  },
])

createRoot(document.getElementById('root')).render(<RouterProvider router={router} />)
